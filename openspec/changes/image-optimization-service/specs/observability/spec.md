## ADDED Requirements

### Requirement: Structured logging

All components SHALL emit structured JSON logs at a configurable level, and logs MUST NOT contain credentials, signed URL signatures, or raw image bytes.

#### Scenario: Request is logged

- **WHEN** any control-plane request completes
- **THEN** a structured record is emitted containing the route, status, duration, asset identifier where applicable, and correlation identifier

#### Scenario: Log record is inspected for secrets

- **WHEN** log output is reviewed
- **THEN** no API key, signature, or presigned URL query string appears in it

### Requirement: Correlation across components

A correlation identifier SHALL be created at ingest and propagated through the queue into the worker and into storage operations, so one asset's full lifecycle can be reconstructed from logs.

#### Scenario: Tracing an upload end to end

- **WHEN** an operator filters logs by a single asset identifier
- **THEN** the upload request, validation outcome, promotion, queue message, worker execution, and derivative writes are all retrievable as one sequence

#### Scenario: Client supplies its own correlation identifier

- **WHEN** a request arrives carrying a correlation header
- **THEN** that value is adopted and propagated rather than replaced

### Requirement: Generation metrics

The system SHALL publish metrics for generation latency, generation count, and generation failures, dimensioned by output format and size bucket.

#### Scenario: Encoder regression is introduced

- **WHEN** a change substantially increases generation time for a format
- **THEN** the latency metric for that format shifts and is visible without inspecting logs

#### Scenario: Failures are classified

- **WHEN** generation fails
- **THEN** the failure metric carries a reason dimension distinguishing corrupt input, timeouts, storage errors, and unexpected errors

### Requirement: On-demand generation rate is monitored

The system SHALL publish the rate of on-demand generations and MUST alarm when that rate remains elevated rather than decaying toward zero for established assets.

#### Scenario: Normalization drift occurs

- **WHEN** the edge normalizer and the core library disagree, causing every request to miss and regenerate
- **THEN** the on-demand generation rate stays elevated and an alarm fires, even though error rates and status codes remain normal

#### Scenario: Healthy steady state

- **WHEN** the system is operating correctly
- **THEN** on-demand generation tracks new asset and new variant introduction and decays for established assets

### Requirement: Delivery metrics

The system SHALL expose cache hit ratio, request counts, error rates by status class, and bytes served dimensioned by output format.

#### Scenario: Cache fragmentation appears

- **WHEN** a change causes cache keys to fragment
- **THEN** the cache hit ratio falls and crosses its alarm threshold

#### Scenario: Format adoption is reviewed

- **WHEN** an operator reviews bytes served by format
- **THEN** the share delivered as modern formats is visible, providing a direct read on the dominant cost driver

### Requirement: Queue health metrics

The system SHALL monitor queue depth, oldest-message age, in-flight count, and dead-letter queue depth.

#### Scenario: Worker stalls

- **WHEN** the worker stops consuming successfully
- **THEN** queue depth and oldest-message age rise and an alarm fires before user-visible symptoms appear

#### Scenario: Message reaches the dead-letter queue

- **WHEN** any message lands in the dead-letter queue
- **THEN** an alarm fires immediately, because the expected steady-state depth is zero

### Requirement: Upload rejection metrics

The system SHALL count upload rejections dimensioned by reason.

#### Scenario: A client integration sends wrong content types

- **WHEN** a consuming application begins sending mismatched content types
- **THEN** the rejection metric for that reason rises, distinguishing an integration bug from an attack

### Requirement: Distributed tracing on the control path

The system SHALL support distributed tracing across the API, queue, worker, and storage calls. The high-volume delivery path MUST NOT be traced per request.

#### Scenario: Slow upload is investigated

- **WHEN** an operator investigates a slow upload
- **THEN** a trace shows the time spent in validation, storage operations, database writes, and enqueueing

#### Scenario: Delivery traffic is considered

- **WHEN** cached image requests are served
- **THEN** no per-request trace is emitted, because tracing at delivery volume would cost more than the traffic it observes

### Requirement: Alarms

The system SHALL define alarms for dead-letter depth above zero, queue age beyond threshold, generation failure rate beyond threshold, cache hit ratio below threshold, elevated server error rate, and unhealthy control-plane tasks.

#### Scenario: Generation begins failing broadly

- **WHEN** the generation failure rate exceeds its configured threshold
- **THEN** an alarm transitions to alert state and notifies the configured target

#### Scenario: All conditions are healthy

- **WHEN** the system is operating within thresholds
- **THEN** no alarm is in alert state

### Requirement: Operational dashboard

The deployment SHALL provision a dashboard covering delivery health, pipeline health, cost proxies, and volume, so a single view answers whether the service is healthy.

#### Scenario: Operator opens the dashboard during an incident

- **WHEN** an operator reviews the dashboard
- **THEN** cache hit ratio, error rates, queue depth, dead-letter depth, generation latency, bytes served, and upload volume are all visible without composing ad-hoc queries

### Requirement: Health endpoints

The control plane SHALL expose liveness and readiness endpoints, with readiness reflecting dependency availability.

#### Scenario: Database is unreachable at startup

- **WHEN** the control plane cannot reach the database
- **THEN** the readiness endpoint reports not ready so the load balancer withholds traffic, while the liveness endpoint continues to report the process alive
