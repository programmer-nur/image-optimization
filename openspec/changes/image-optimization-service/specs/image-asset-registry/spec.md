## ADDED Requirements

### Requirement: Asset identity

Every uploaded image SHALL be assigned a stable, URL-safe, lexicographically sortable identifier that is independent of storage location, filename, and content.

#### Scenario: Identifier is issued at upload initiation

- **WHEN** an upload is initiated through either ingest mode
- **THEN** an asset identifier is generated and returned to the client before the bytes are stored, and that identifier never changes for the life of the asset

### Requirement: Asset versioning

Each asset SHALL have a monotonically increasing integer version. Replacing an asset's source bytes MUST increment the version rather than modify the existing version.

#### Scenario: Source is replaced

- **WHEN** a client calls `PUT /v1/images/{id}/source`
- **THEN** a new asset version row is created, `current_version` is advanced, delivery URLs for the new version are returned, and URLs referencing the previous version continue to resolve until that version's objects are lifecycle-expired

#### Scenario: Old version URLs during the retention window

- **WHEN** a browser requests a derivative of a superseded version that is still within the retention window
- **THEN** the request is served normally from the stored derivative

### Requirement: Intrinsic metadata capture

The service SHALL record the source image's intrinsic properties on its asset version: pixel width, pixel height, detected format, byte size, colorspace, alpha presence, EXIF orientation, dominant color, and content hash.

#### Scenario: Metadata extracted during optimization

- **WHEN** the optimizer processes a newly stored original
- **THEN** all intrinsic properties are written to the asset version record and the asset status advances to `ready`

#### Scenario: Metadata is available before processing completes

- **WHEN** a client fetches asset metadata while status is `stored`
- **THEN** the response includes the identifier, version, status, and delivery URLs, with intrinsic dimension fields marked as not yet available

### Requirement: Status lifecycle

An asset SHALL occupy exactly one of the states `pending_upload`, `stored`, `ready`, `rejected`, `failed`, or `deleted`, and transitions MUST be recorded with a timestamp and, for terminal failure states, a machine-readable reason.

#### Scenario: Processing fails permanently

- **WHEN** the optimizer exhausts its retries on an asset
- **THEN** the asset status becomes `failed` with a reason, the job lands in the dead-letter queue, and the failure is surfaced as a metric

### Requirement: Metadata retrieval

`GET /v1/images/{id}` SHALL return the asset's metadata, its status, its intrinsic dimensions, its LQIP placeholder, a canonical delivery URL, and a ready-to-use `srcset` string.

#### Scenario: Client fetches a ready asset

- **WHEN** a client requests a `ready` asset
- **THEN** the response contains the asset metadata, the base64 LQIP, the intrinsic width and height, and a `srcset` whose candidates are capped at the source width

#### Scenario: Client fetches a deleted asset

- **WHEN** a client requests an asset whose status is `deleted`
- **THEN** the service responds `404`

### Requirement: Editable asset attributes

The service SHALL allow updating an asset's alt text, tags, and focal point via `PATCH /v1/images/{id}` without changing the asset version or invalidating cached derivatives.

#### Scenario: Alt text is updated

- **WHEN** a client patches alt text on an asset
- **THEN** the metadata is updated, the asset version is unchanged, and no cached derivative is affected

#### Scenario: Focal point is updated

- **WHEN** a client patches the focal point on an asset
- **THEN** the value is stored as advisory metadata, the asset version is unchanged, and no derivative is re-generated — the delivery plane never reads the registry, so a stored point cannot reach a render, which is also why `crop=focal` is not part of the URL grammar

### Requirement: Derivative inventory

`GET /v1/images/{id}/variants` SHALL list the derivatives that have actually been materialized for the asset, including canonical key, format, dimensions, byte size, generation timestamp, and whether it was produced eagerly or on demand.

#### Scenario: Operator inspects generated variants

- **WHEN** an operator requests the variant list for an asset
- **THEN** the response enumerates every materialized derivative with its size and origin, enabling per-asset storage attribution

### Requirement: Deletion

`DELETE /v1/images/{id}` SHALL soft-delete the asset record, remove its objects under `original/`, `master/`, and `derived/`, and issue a CDN invalidation scoped to that asset's delivery path prefix.

#### Scenario: Asset is deleted

- **WHEN** a client deletes an asset
- **THEN** the asset status becomes `deleted`, all S3 objects for every version of that asset are removed, a wildcard CDN invalidation is issued for the asset path, and subsequent delivery requests return `404`

#### Scenario: Deletion is retried after partial failure

- **WHEN** object removal partially fails during deletion
- **THEN** the asset remains marked `deleted`, the residual objects are recorded, and the orphan collection job removes them on its next run

### Requirement: Reprocessing

`POST /v1/images/{id}/reprocess` SHALL re-enqueue warm-set generation for the asset's current version without changing the version number.

#### Scenario: Operator reprocesses a failed asset

- **WHEN** an operator reprocesses an asset whose status is `failed`
- **THEN** a new optimization job is enqueued, and on success the asset status returns to `ready`

### Requirement: Delivery path independence from the database

Reads on the delivery plane SHALL NOT query the asset registry. The existence of an S3 object at a canonical key MUST be the sole authority for whether a derivative can be served.

#### Scenario: Database is unavailable

- **WHEN** the PostgreSQL instance is unreachable
- **THEN** all previously generated images continue to be delivered normally, and on-demand generation of new variants also continues, with only registry bookkeeping degraded
