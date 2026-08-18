## ADDED Requirements

### Requirement: A tenant is the unit of ownership

The service SHALL model a tenant as the owner of assets, API keys, and quota. Every asset and every API key SHALL belong to exactly one tenant, and a deployment SHALL always have at least one — a single-tenant installation is a deployment with one tenant row, not a deployment without the concept.

#### Scenario: A single-tenant deployment is migrated

- **WHEN** an existing single-tenant deployment applies this change
- **THEN** one tenant is created, every existing asset and key is attributed to it, and no delivery URL, object key, or cached response changes

#### Scenario: Quota is accounted against the tenant

- **WHEN** any operation that stores bytes succeeds
- **THEN** the bytes are counted against the tenant that owns the asset, not against whichever key performed the operation, so issuing a second key to the same application cannot double its allowance

### Requirement: Requests are bound to one tenant

Every authenticated request SHALL resolve to exactly one tenant, derived from the presented API key. A request SHALL NOT be able to name a tenant, because a caller-supplied tenant identifier is an authorization decision made by the caller.

#### Scenario: A key is presented

- **WHEN** a request authenticates with an API key
- **THEN** the tenant is taken from the key's own record, and every subsequent database read and write in that request is scoped to it

#### Scenario: A request supplies a tenant identifier

- **WHEN** a request carries a tenant identifier in a header, path, or body
- **THEN** it is ignored, because trusting it would let any valid key act as any tenant

### Requirement: A foreign identifier is indistinguishable from a missing one

Reads and writes addressing an asset owned by another tenant SHALL respond `404`, never `403`. The service SHALL NOT reveal that an identifier exists to a caller not entitled to it.

#### Scenario: An asset id belonging to another tenant is requested

- **WHEN** a caller requests, updates, replaces, reprocesses, or deletes an asset id owned by a different tenant
- **THEN** the response is `404` with the same body a genuinely unknown id produces — a `403` would confirm the id is real, which is the one bit an enumeration attempt is looking for

#### Scenario: Listing is scoped

- **WHEN** a caller lists assets
- **THEN** only that tenant's assets appear, and pagination cursors cannot be used to step outside the tenant

### Requirement: Deduplication does not cross tenants

Content-hash deduplication SHALL match only within the requesting tenant.

#### Scenario: Two tenants upload identical bytes

- **WHEN** a tenant uploads bytes whose hash matches an asset owned by a different tenant
- **THEN** a new asset is created for the uploading tenant, because returning the existing one would disclose that another tenant holds those exact bytes and would give one tenant a reference to another's asset

### Requirement: Scoping is enforced by construction, not by convention

The registry SHALL make an unscoped query impossible to write by accident: repository access SHALL require a tenant scope obtained from an authenticated request, and any deliberately unscoped access SHALL be separately named and restricted to jobs that legitimately operate across tenants.

#### Scenario: A new endpoint is added

- **WHEN** a developer adds a route that reads assets
- **THEN** it cannot compile without supplying a tenant scope, so the failure mode is a build error rather than a cross-tenant read discovered in production

#### Scenario: Scheduled reclamation runs

- **WHEN** the maintenance worker walks storage and the registry
- **THEN** it uses the explicitly unscoped access path, because reclamation is deployment-wide by nature, and that path is named so its use is visible in review

### Requirement: The delivery plane is out of scope for tenant isolation

Tenant isolation SHALL be a control-plane property only. The delivery plane never reads the registry (design.md D1), so it cannot know which tenant an asset belongs to, and the service SHALL NOT claim that delivery URLs are confidential.

#### Scenario: A delivery URL is shared

- **WHEN** a delivery URL for one tenant's asset is given to anyone
- **THEN** it serves the image, exactly as it does today, because delivery is unauthenticated by design and asset ids are unguessable rather than secret

#### Scenario: Confidential images are required

- **WHEN** a consuming application needs images that must not be readable by URL alone
- **THEN** that is a separate capability requiring a distinct key space chosen at ingest, and this change does not provide it
