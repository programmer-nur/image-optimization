## ADDED Requirements

### Requirement: Authenticated write operations

All mutating control-plane endpoints SHALL require a valid API key. Delivery of public assets MUST NOT require authentication.

#### Scenario: Upload without credentials

- **WHEN** an unauthenticated client attempts to upload
- **THEN** the request is rejected with `401` and no asset record is created

#### Scenario: Delete with a valid key

- **WHEN** a client presents a valid API key with delete permission
- **THEN** the deletion proceeds

#### Scenario: Public image is fetched anonymously

- **WHEN** a browser requests a public delivery URL with no credentials
- **THEN** the image is served

### Requirement: The control plane is reachable only over TLS

The control-plane load balancer SHALL terminate TLS with a certificate for its configured hostname, and MUST answer plain HTTP only to redirect to it. Production deployment SHALL fail to synthesize when no certificate is resolvable, rather than falling back to plain HTTP.

#### Scenario: A client presents an API key

- **WHEN** a client sends `x-api-key` to the control plane
- **THEN** the request travels over TLS 1.2 or later, because the credential and the upload payload are both in the clear otherwise

#### Scenario: A client connects over plain HTTP

- **WHEN** a client connects to port 80
- **THEN** it is redirected to the HTTPS endpoint and no request is served over the plaintext listener

#### Scenario: Production is deployed without a certificate

- **WHEN** synthesis runs for production and neither an explicit certificate ARN nor a hostname with a usable hosted zone is configured
- **THEN** synthesis fails naming the missing setting, because the alternative — an optional setting nobody supplies — is how a control plane comes to serve credentials in cleartext without anyone noticing

### Requirement: API keys are stored hashed

API keys SHALL be persisted only as hashes, and the plaintext value MUST be shown exactly once at creation. The hash is an unsalted SHA-256 of the whole key: the secret half is 32 bytes from a cryptographic RNG, so there is no dictionary for a salt to defeat and no password-stretching to do. A key store holding user-chosen secrets would require both.

#### Scenario: Key is created

- **WHEN** an API key is issued
- **THEN** the plaintext is returned once in the response and only its hash is stored

#### Scenario: Key is revoked

- **WHEN** a key is revoked
- **THEN** subsequent requests bearing it are rejected

### Requirement: Rate limiting on write endpoints

The service SHALL enforce request-rate limits on mutating endpoints at the edge of the control plane, without requiring shared state between application instances.

#### Scenario: Client exceeds the upload rate limit

- **WHEN** a client exceeds the configured request rate for uploads
- **THEN** further requests are rejected with `429` before reaching application code

#### Scenario: Multiple application instances are running

- **WHEN** the control plane is scaled to several instances
- **THEN** rate limiting remains effective because it is enforced ahead of the application rather than per-instance

### Requirement: Upload quotas

The service SHALL enforce configurable per-key limits on total stored bytes and on asset count.

#### Scenario: Quota is exceeded

- **WHEN** an upload would take a key past its configured storage quota
- **THEN** the upload is rejected with a quota error and no bytes are promoted to permanent storage

### Requirement: File type is verified from content

The service SHALL determine file type from magic bytes and MUST reject any upload whose detected type is absent from the accept list or disagrees with the declared type.

#### Scenario: Executable disguised as an image

- **WHEN** a file with an executable signature is uploaded with an image content type
- **THEN** it is rejected before promotion and the staging object is deleted

### Requirement: Resource-exhaustion defenses

The service SHALL bound the resources any single upload or transformation can consume through explicit size, dimension, and decoded-pixel limits.

#### Scenario: Decompression bomb

- **WHEN** a small file that would decode to an enormous bitmap is submitted
- **THEN** it is rejected at validation and the processor's pixel limit provides a second line of defense

#### Scenario: Oversized upload attempt

- **WHEN** a client attempts to upload beyond the configured maximum size using a presigned target
- **THEN** the storage service itself rejects the request because the presigned policy constrains content length

### Requirement: Delivered bytes are always re-encoded

Every image delivered through the CDN SHALL be output produced by the processing pipeline. Source bytes MUST NOT be passed through to viewers.

#### Scenario: Polyglot file is uploaded

- **WHEN** a file that is simultaneously a valid image and a valid HTML document is uploaded and later requested
- **THEN** the viewer receives re-encoded image output rather than the original bytes, and the response asserts that content-type sniffing is disallowed

### Requirement: Malware scanning of untrusted uploads

Uploaded bytes SHALL be scanned for malware while in the staging prefix, and a positive finding MUST prevent promotion.

#### Scenario: Malicious file is detected

- **WHEN** scanning reports a threat for a staged object
- **THEN** the object is quarantined or deleted, the asset is marked rejected, and the event is recorded for review

#### Scenario: Scanning is unavailable

- **WHEN** the scanning service cannot return a verdict
- **THEN** the upload is held rather than promoted, according to the configured fail-closed policy

### Requirement: Privacy metadata is not exposed

Originals SHALL NOT be publicly reachable, and all delivered derivatives MUST have embedded metadata removed.

#### Scenario: Photo with location data is delivered

- **WHEN** a photograph containing GPS coordinates is delivered through the CDN
- **THEN** the delivered bytes contain no location metadata and the original remains unreachable from the public internet

### Requirement: Bounded variant space as an abuse control

The public transform surface SHALL NOT permit an unbounded number of distinct derivatives per asset, so that request-driven cost cannot be amplified without limit.

#### Scenario: Attacker iterates many parameter combinations

- **WHEN** an attacker requests a large number of distinct parameter combinations against one asset
- **THEN** the number of generations is bounded by the normalized variant space, and subsequent requests are cache hits rather than new work

#### Scenario: Attacker sends malformed parameters at high volume

- **WHEN** malformed requests arrive at high volume
- **THEN** they are rejected at the edge without any origin, storage, or compute cost

### Requirement: Signed delivery links

The service SHALL support time-limited, revocable signed delivery links under a dedicated path prefix, disabled by default. The signature is a property of the _link_, not of the asset: it buys expiry and revocation on a URL that was handed out, and it is scoped to one prefix rather than to a set of assets.

#### Scenario: Signed prefix requested without a signature

- **WHEN** the signature-required prefix is requested without a valid signature
- **THEN** CloudFront denies the request at the edge, before any origin, storage, or compute cost

#### Scenario: Signed link is presented before it expires

- **WHEN** a valid unexpired signature is presented
- **THEN** the request normalizes into the same derived key space as public delivery and the image is served, so a signed asset is bucketed exactly like any other

#### Scenario: The same asset is requested through the public prefix

- **WHEN** a caller who knows the asset id and version requests it through the public prefix
- **THEN** it is served, because visibility is a property of the URL and not of the asset — per-asset privacy would require the delivery plane to know an asset's visibility, and the delivery plane never reads the registry (design.md D1). Making it a property of the asset means a separate key space chosen at ingest, which is a design change and not a configuration one.

### Requirement: Least-privilege service permissions

Each compute component SHALL hold only the storage and queue permissions its role requires, scoped to specific prefixes.

#### Scenario: Generator permissions are inspected

- **WHEN** the on-demand generator's permissions are reviewed
- **THEN** it can read the originals and masters prefixes and write only the derivatives prefix, and it holds no delete permission on originals

#### Scenario: Distribution permissions are inspected

- **WHEN** the distribution's read access is reviewed
- **THEN** it can read only the derivatives prefix and cannot list the bucket
