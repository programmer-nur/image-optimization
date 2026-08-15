## ADDED Requirements

### Requirement: Custom CDN domain

Images SHALL be delivered from a configurable custom domain backed by a managed TLS certificate, and the underlying distribution hostname MUST NOT appear in generated URLs.

#### Scenario: Delivery URL is generated

- **WHEN** the service generates a delivery URL for an asset
- **THEN** it uses the configured custom CDN hostname over HTTPS

#### Scenario: Request arrives over plain HTTP

- **WHEN** a viewer requests an image over HTTP
- **THEN** the request is redirected to HTTPS

### Requirement: Edge normalization defines the cache key

A viewer-request edge function SHALL validate and normalize transform parameters, rewrite the request path to the canonical derivative key, and remove the query string, so that the cache key is the normalized path alone.

#### Scenario: Query string is eliminated before cache lookup

- **WHEN** a request with transform parameters reaches the edge
- **THEN** the parameters are resolved into the rewritten path, the query string is dropped, and the cache lookup uses only the normalized path

#### Scenario: Equivalent requests share a cache entry

- **WHEN** two requests differing only in parameter order, letter case, tracking parameters, or a width within the same bucket arrive
- **THEN** both produce the same rewritten path and hit the same cache entry

### Requirement: Format negotiation at the edge

When the requested format is `auto`, the edge function SHALL select the output format from the viewer's `Accept` header and encode that choice into the rewritten path.

#### Scenario: Browser advertises AVIF support

- **WHEN** a request has `format=auto` and an `Accept` header including AVIF
- **THEN** the rewritten path targets an AVIF derivative

#### Scenario: Browser advertises only WebP support

- **WHEN** a request has `format=auto` and an `Accept` header including WebP but not AVIF
- **THEN** the rewritten path targets a WebP derivative

#### Scenario: Browser advertises neither

- **WHEN** a request has `format=auto` and an `Accept` header with neither modern format
- **THEN** the rewritten path targets JPEG, or PNG when the source has transparency

#### Scenario: Cache is not fragmented by Accept header variation

- **WHEN** viewers send many different `Accept` header strings that all include AVIF
- **THEN** they all resolve to the same rewritten path and share one cache entry, because the header is reduced to a format choice rather than varied on directly

#### Scenario: Explicit format overrides negotiation

- **WHEN** a request specifies an explicit format
- **THEN** the `Accept` header is not consulted and the requested format is used

### Requirement: Storage-first origin with generator failover

The distribution SHALL use an origin group whose primary origin is object storage and whose failover origin is the on-demand generator, with failover triggered by the storage responses that indicate a missing object.

#### Scenario: Derivative already exists

- **WHEN** the normalized path corresponds to a stored object
- **THEN** the object is served from storage and cached at the edge, with no generator invocation

#### Scenario: Derivative does not exist

- **WHEN** the normalized path corresponds to no stored object and storage returns a missing-object status
- **THEN** the distribution transparently retries against the generator origin with the same path, and the viewer receives the generated image with a success status

#### Scenario: Storage returns forbidden rather than not-found

- **WHEN** origin access control causes a missing object to be reported as forbidden rather than not found
- **THEN** the failover criteria still trigger the generator, so viewers never see a forbidden response for a legitimately ungenerated variant

### Requirement: Immutable caching headers

Successfully delivered derivatives SHALL carry a long-lived immutable cache directive and an entity tag, and the headers MUST be identical whether the response came from storage or from the generator.

#### Scenario: Derivative is served from storage

- **WHEN** a stored derivative is delivered
- **THEN** it carries a public, one-year, immutable cache directive and an entity tag

#### Scenario: Derivative is served from the generator on first request

- **WHEN** a derivative is generated on demand and returned directly
- **THEN** its caching headers are identical to those the stored object will later carry, so the first viewer and all later viewers cache it the same way

#### Scenario: Conditional request with a matching entity tag

- **WHEN** a client revalidates with a matching entity tag
- **THEN** a not-modified response is returned with no body

### Requirement: Vary on Accept for negotiated responses

Responses whose format was selected by negotiation SHALL declare that they vary on the `Accept` header, for the benefit of browser and intermediary caches.

#### Scenario: Negotiated response is emitted

- **WHEN** a response results from `format=auto`
- **THEN** it declares variance on `Accept`, without that declaration affecting the CDN's own cache key

### Requirement: Invalidation is reserved for deletion

Routine content changes SHALL be handled by minting new versioned URLs rather than by invalidating the CDN. Invalidation MUST be used only for deletions and takedowns.

#### Scenario: Source image is replaced

- **WHEN** an asset's source bytes are replaced
- **THEN** a new version segment produces entirely new URLs and no invalidation is issued

#### Scenario: Encoder policy changes globally

- **WHEN** the encoder epoch is incremented
- **THEN** every asset's URLs change at once with no invalidation and no per-asset database write

#### Scenario: Asset is deleted

- **WHEN** an asset is deleted
- **THEN** a wildcard invalidation scoped to that asset's delivery path is issued so cached copies stop being served

### Requirement: Error responses at the edge

The distribution SHALL apply short cache lifetimes to client and not-found errors and MUST NOT cache generation failures.

#### Scenario: Invalid parameters are rejected at the edge

- **WHEN** the edge function rejects malformed parameters
- **THEN** a client error is returned with a short cache lifetime and no origin request is made

#### Scenario: Generator returns a server error

- **WHEN** the generator origin fails
- **THEN** the error response is not stored at the edge, and a later request attempts generation again

### Requirement: Origin request collapsing

The distribution SHALL collapse concurrent requests for the same uncached key into a minimal number of origin fetches.

#### Scenario: Simultaneous misses for a newly published image

- **WHEN** a large number of viewers request the same uncached variant at the same moment
- **THEN** origin request collapsing reduces the origin fetches, and the generator is invoked far fewer times than the number of viewer requests

### Requirement: Origin storage is not publicly reachable

The storage bucket SHALL be private, with the distribution as its only permitted reader, and only the derivative prefix MAY be readable through the CDN.

#### Scenario: Direct request to the storage endpoint

- **WHEN** a client requests an object directly from the storage endpoint
- **THEN** the request is denied

#### Scenario: Attempt to reach an original through the CDN

- **WHEN** a client constructs a CDN path targeting the originals prefix
- **THEN** the request does not resolve to the original object, because only the derivative prefix is exposed
