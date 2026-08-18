## MODIFIED Requirements

### Requirement: Content-hash deduplication

The service SHALL compute a SHA-256 hash of each uploaded original and MUST record it on the asset version. Deduplication SHALL be scoped to the uploading tenant.

#### Scenario: Identical bytes uploaded twice by one tenant

- **WHEN** a tenant uploads bytes whose SHA-256 matches an existing non-deleted asset version it owns
- **THEN** the service discards the newly staged object, returns the existing asset with `duplicate` set, and releases the quota it reserved

#### Scenario: Identical bytes uploaded by a different tenant

- **WHEN** a tenant uploads bytes matching an asset owned by another tenant
- **THEN** a new asset is created for the uploading tenant and `duplicate` is false

#### Scenario: An asset's source is replaced with bytes another asset already holds

- **WHEN** a client calls `PUT /v1/images/{id}/source` with bytes matching a different asset
- **THEN** deduplication does not apply and a new version of _this_ asset is written, because the caller named an asset to version rather than asking to be redirected to whichever asset happens to share the bytes

### Requirement: Editable asset attributes

The service SHALL allow updating an asset's alt text, tags, and focal point via `PATCH /v1/images/{id}` without changing the asset version or invalidating cached derivatives. The asset MUST belong to the caller's tenant.

#### Scenario: Alt text is updated

- **WHEN** a client patches alt text on an asset its tenant owns
- **THEN** the metadata is updated, the asset version is unchanged, and no cached derivative is affected

#### Scenario: Focal point is updated

- **WHEN** a client patches the focal point on an asset
- **THEN** the value is stored as advisory metadata, the asset version is unchanged, and no derivative is re-generated — the delivery plane never reads the registry, so a stored point cannot reach a render, which is also why `crop=focal` is not part of the URL grammar

#### Scenario: Another tenant's asset is patched

- **WHEN** a client patches an asset owned by a different tenant
- **THEN** the response is `404` and no column changes
