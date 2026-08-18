## ADDED Requirements

### Requirement: Asynchronous optimization jobs

Optimization SHALL be driven by a durable queue consumed by a worker, and MUST never execute inline with an upload request.

#### Scenario: Job is enqueued on successful upload

- **WHEN** an original is promoted to permanent storage
- **THEN** an optimization job carrying the asset identifier, version, and correlation identifier is enqueued, and the upload response is returned without waiting for it

### Requirement: Eager warm set

On upload the worker SHALL generate a configured warm set of derivatives plus a low-quality image placeholder, and MUST record the extracted intrinsic metadata.

#### Scenario: Default warm set is produced

- **WHEN** the optimizer processes a newly uploaded image with default configuration
- **THEN** it produces the LQIP placeholder, one primary-width derivative in the modern default format capped at the source width, and writes intrinsic metadata to the asset version

#### Scenario: Warm set is widened by configuration

- **WHEN** the deployment configures additional warm widths and formats
- **THEN** the optimizer generates each configured combination, capping any width that exceeds the source width and deduplicating widths that collapse onto the same ladder value, so no derivative upscales and none is generated twice

#### Scenario: Configured warm width exceeds a small source

- **WHEN** a warm width larger than the source is configured and a small source is processed
- **THEN** the width is capped to the largest ladder value not exceeding the source, and a warm derivative is produced at that capped width rather than skipped

#### Scenario: LQIP is stored for inline use

- **WHEN** the placeholder is generated
- **THEN** it is stored as a base64 string on the asset version record rather than as an S3 object, so clients can inline it without an extra network request

### Requirement: Conditional master rendition

The worker SHALL generate a master rendition only when the original exceeds the configured size or dimension threshold, and the master MUST NOT be deliverable to clients.

#### Scenario: Very large original is uploaded

- **WHEN** an original exceeds the master threshold
- **THEN** a quality-preserving bounded-dimension master is written and recorded on the asset version, and later derivative generation decodes the master instead of the original

#### Scenario: Ordinary original is uploaded

- **WHEN** an original is below the master threshold
- **THEN** no master is produced and derivatives are generated directly from the original

#### Scenario: Master is requested through the delivery API

- **WHEN** any delivery URL is constructed
- **THEN** no URL can address the master prefix, because masters are intermediates rather than delivery artifacts

### Requirement: On-demand generation on cache miss

When a delivery request resolves to a canonical key with no stored object, the system SHALL generate that derivative on demand, persist it at that exact key, and return it in the same response.

#### Scenario: First request for an uncached variant

- **WHEN** a browser requests a variant that has never been generated
- **THEN** the generator produces it, writes it to the canonical key, and returns the image bytes with the same caching headers a stored object would carry

#### Scenario: Second request for the same variant

- **WHEN** the same variant is requested again after generation
- **THEN** it is served from the CDN cache or from storage, and the generator is not invoked

### Requirement: Each derivative is generated at most once

For a given asset version and canonical key, generation SHALL occur at most once under normal operation, and repeated delivery requests MUST NOT cause repeated generation.

#### Scenario: Sustained traffic to a single variant

- **WHEN** a variant receives continuous traffic over an extended period
- **THEN** the generation count for that key remains one, and compute cost does not scale with request volume

#### Scenario: Ongoing on-demand generation is detected

- **WHEN** the on-demand generation rate for already-generated keys remains non-zero over time
- **THEN** it is surfaced as an operational alarm, because it indicates a normalization mismatch rather than legitimate demand

### Requirement: Concurrent generation is safe

Concurrent generation of the same canonical key SHALL NOT corrupt the stored object, and the system MUST NOT require a distributed lock.

#### Scenario: Simultaneous first requests for the same variant

- **WHEN** many requests for the same uncached variant arrive at once
- **THEN** origin request collapsing reduces them to a minimal number of generator invocations, conditional writes ensure only the first stored object persists, and every requester receives correct bytes

#### Scenario: Two generators write concurrently

- **WHEN** two generator invocations attempt to store the same key
- **THEN** the conditional write causes one to succeed and the other to discard its output without error, and because generation is deterministic the outcome is identical either way

### Requirement: Generator concurrency is bounded

The on-demand generator SHALL have a reserved concurrency limit so that a burst of misses cannot cause unbounded parallel execution.

#### Scenario: Large burst of distinct uncached variants

- **WHEN** a burst of requests for many distinct uncached variants arrives
- **THEN** generator concurrency is capped at the configured reservation, excess requests queue or fail fast with a short-lived error, and spend remains bounded

### Requirement: Retry and dead-lettering

Optimization jobs SHALL be retried with backoff on transient failure and MUST be routed to a dead-letter queue after the configured maximum attempts. A failure classified as terminal SHALL be acknowledged rather than retried or dead-lettered, so the dead-letter queue holds only work that repeated attempts failed to complete.

#### Scenario: Transient storage error during optimization

- **WHEN** the worker encounters a retriable storage error
- **THEN** the job returns to the queue and is retried with exponential backoff

#### Scenario: Permanently corrupt source

- **WHEN** the worker classifies a failure as non-retriable, such as a corrupt source
- **THEN** the asset status becomes `failed` with a machine-readable reason and the message is acknowledged, because redelivering it would burn the retry budget to reach the same conclusion and then park an unactionable message in a queue whose alarm has no tolerance

#### Scenario: Dead-letter queue receives a message

- **WHEN** any message arrives in the dead-letter queue
- **THEN** an alarm fires, because the queue is expected to remain empty: terminal failures never arrive here, so anything that does is retriable work that never succeeded

### Requirement: Idempotent job processing

Processing the same optimization job more than once SHALL be safe and MUST NOT produce duplicate or conflicting artifacts.

#### Scenario: Queue delivers a message twice

- **WHEN** the same optimization job is delivered more than once
- **THEN** the worker regenerates deterministically to the same keys, and the resulting state is identical to a single delivery

### Requirement: Regeneration triggers

Derivatives SHALL be regenerated only when the asset version changes, when the encoder epoch changes, or when reprocessing is explicitly requested. There MUST be no time-based expiry that causes regeneration.

#### Scenario: Encoder epoch is incremented

- **WHEN** the deployment-wide encoder epoch is incremented
- **THEN** all delivery URLs resolve to a new canonical key space, new derivatives are generated on demand, and prior derivatives remain untouched until lifecycle expiry

#### Scenario: A cached derivative simply ages

- **WHEN** a derivative has existed for an extended period with no version or epoch change
- **THEN** it is never regenerated and continues to be served

### Requirement: Failure does not poison the cache

A failed generation SHALL NOT result in a stored object, and MUST NOT be cached at the edge.

#### Scenario: Generator times out

- **WHEN** generation exceeds the configured timeout
- **THEN** no partial object is written to storage, the error response is marked non-storable, and a subsequent request retries generation cleanly
