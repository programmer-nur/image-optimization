## ADDED Requirements

### Requirement: Proxied multipart upload

The service SHALL accept an original image via `POST /v1/images` as a multipart request. The request body MUST be streamed directly into S3 without buffering the complete file in process memory or writing it to container-local disk.

#### Scenario: Small image uploaded through the API

- **WHEN** a client `POST`s a 3MB JPEG to `/v1/images` with a valid API key
- **THEN** the service streams the bytes into a staging S3 object, validates them, promotes the object to `original/{assetId}/1/source.jpg`, creates an asset record with status `stored`, enqueues an optimization job, and responds `202` with `{ assetId, version, urls }`

#### Scenario: Proxied upload exceeds the proxy threshold

- **WHEN** a client `POST`s a file larger than the configured proxy threshold to `/v1/images`
- **THEN** the service responds `413` with a message directing the client to the presigned upload flow, and no partial object is retained

### Requirement: Presigned direct-to-S3 upload

The service SHALL provide a presigned upload flow so that large files never transit the API container. `POST /v1/images/uploads` MUST return credentials targeting a `staging/{uploadId}` key, and the presigned policy MUST include a `content-length-range` condition and a `Content-Type` condition.

#### Scenario: Client requests a presigned upload target

- **WHEN** a client `POST`s to `/v1/images/uploads` declaring a content type and byte size within configured limits
- **THEN** the service creates an asset record with status `pending_upload` and returns a presigned target scoped to `staging/{uploadId}` that expires within the configured TTL

#### Scenario: Client uploads bytes exceeding the declared range

- **WHEN** a client uses the presigned target to upload more bytes than the `content-length-range` maximum
- **THEN** S3 rejects the upload directly and no object is created

#### Scenario: Presigned target expires before use

- **WHEN** a client attempts to upload using a presigned target after its TTL has elapsed
- **THEN** S3 rejects the request, and the abandoned `pending_upload` asset record is reaped by the staging cleanup job

### Requirement: Large file support

The service SHALL support original files up to a configured maximum of at least 100MB without upload failure. For files above the multipart threshold, the presigned flow MUST issue multipart upload part URLs.

#### Scenario: 100MB source is uploaded

- **WHEN** a client uploads a 100MB TIFF through the presigned multipart flow and calls the completion endpoint
- **THEN** the upload succeeds, the original is stored unmodified, and the response is returned without waiting for any image processing

### Requirement: Validation occurs before promotion

The service SHALL validate uploaded bytes while they reside in the `staging/` prefix and MUST promote them to `original/` only after all validation passes. Objects under `staging/` MUST NOT be reachable through the CDN and MUST NOT be referenced by any usable asset record.

#### Scenario: Completion triggers validation

- **WHEN** a client calls `POST /v1/images/uploads/{id}/complete`
- **THEN** the service reads the object head and a ranged prefix of its bytes, runs all validation checks, and only on success issues a server-side `CopyObject` from `staging/` to `original/`

#### Scenario: Validation fails

- **WHEN** any validation check fails during completion
- **THEN** the service deletes the staging object, sets the asset status to `rejected` with a machine-readable reason, and responds `422` with that reason

### Requirement: Content type is verified from file signature

The service SHALL determine the true file type from magic bytes. The client-declared `Content-Type` MUST NOT be trusted, and a mismatch between declared and detected type MUST cause rejection.

#### Scenario: File declared as JPEG is actually a PDF

- **WHEN** an upload declares `image/jpeg` but its leading bytes identify a PDF
- **THEN** the upload is rejected with reason `content_type_mismatch` and the staging object is deleted

#### Scenario: File type is not an accepted image format

- **WHEN** an upload's detected type is not in the configured accept list
- **THEN** the upload is rejected with reason `unsupported_format`

### Requirement: Dimension and pixel-count limits

The service SHALL reject images whose decoded pixel count would exceed the configured limit, determined from image headers before any full decode is attempted.

#### Scenario: Decompression bomb is rejected

- **WHEN** a 30KB PNG declaring dimensions of 60000x60000 is uploaded
- **THEN** the service rejects it with reason `pixel_limit_exceeded` without ever allocating a full decode buffer

### Requirement: SVG is rejected by default

The service SHALL reject SVG uploads unless SVG support is explicitly enabled in configuration. When enabled, SVG input MUST be sanitized and MUST always be rasterized; the raw SVG bytes MUST NOT be served through the CDN.

#### Scenario: SVG upload with default configuration

- **WHEN** an SVG file is uploaded and SVG support is disabled
- **THEN** the upload is rejected with reason `unsupported_format`

#### Scenario: SVG upload with SVG support enabled

- **WHEN** an SVG file is uploaded and SVG support is enabled
- **THEN** the file is sanitized to remove scripts and external entity references, stored as an original, and all delivered derivatives are rasterized raster-format outputs

### Requirement: Originals are immutable

Once written, an object under `original/` SHALL never be modified, overwritten, or re-encoded. Any operation that changes an image's source bytes MUST create a new asset version at a new key.

#### Scenario: Source replacement

- **WHEN** a client calls `PUT /v1/images/{id}/source` with new bytes
- **THEN** the service writes `original/{assetId}/{version+1}/source.{ext}` and leaves the previous version's object untouched

### Requirement: Content-hash deduplication

The service SHALL compute a SHA-256 hash of each uploaded original and MUST record it on the asset version.

#### Scenario: Identical bytes uploaded twice

- **WHEN** a client uploads bytes whose SHA-256 matches an existing non-deleted asset version
- **THEN** the service returns the existing asset identifier rather than storing a duplicate original, unless the caller explicitly requests forced creation

### Requirement: Upload response does not wait for processing

The upload endpoints SHALL respond as soon as the original is durably stored and the asset record exists. Image processing MUST be performed asynchronously and MUST NOT be able to fail the upload.

#### Scenario: Optimization queue is unavailable

- **WHEN** the original is stored successfully but enqueueing the optimization job fails
- **THEN** the upload still succeeds with status `stored`, the failure is logged and metered, and a reconciliation job later enqueues the missing work
