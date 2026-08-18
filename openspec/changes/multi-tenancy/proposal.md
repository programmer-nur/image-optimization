## Why

The service is single-tenant by deliberate design — "one deployment serves one project, so there is no tenant column anywhere" (design.md D1, recorded as a Non-Goal). The owner now needs one installation to serve several consuming applications.

Two things force this decision now rather than later. Delivery URLs are immutable and cached for a year (D8), so **the URL space is free exactly once** — before the first production consumer. And the control plane already has ownership holes that are harmless with one trusted application and are not harmless with two.

## What Changes

The recommendation, after evaluating three independent designs, is **not to put tenancy in the URL**, and **not to reverse D1 yet**.

- **Tenancy is the deployment.** A second application is a second deployment; `config.name` is the tenant identity and hostnames separate tenants. `ENVIRONMENTS` becomes a deployment manifest rather than a staging/production pair. This is what D1 already prescribes; the change is making it a supported operation instead of an aside.
- **The control plane gains a `tenantId` column and a scoped repository** — landed with exactly one tenant row per deployment, where it is a runtime no-op. It closes real ownership holes at N=1 and it is what makes a later move to a shared deployment a data migration rather than an audit of every route under time pressure.
- **Ownership is enforced, not assumed.** A read for an id belonging to another tenant answers `404`, never `403` — a 403 confirms the id exists.
- **Quota becomes a property of the tenant**, not of whichever key happened to create an asset. **BREAKING** for any deployment relying on per-key allowances as the accounting unit.
- **Deduplication is scoped.** A content hash matching another tenant's asset must not return that asset.
- **NOT changing:** the URL grammar, the canonical key, the edge normalizer, the storage prefixes, `parseVariantName`, or the client SDK. Zero diff in `packages/core` and `infra/cloudfront`.

## Capabilities

### New Capabilities

- `tenant-isolation`: what a tenant is, how a request is bound to one, what crossing a boundary must do, and what the design deliberately does not promise.

### Modified Capabilities

- `platform-security`: API keys belong to a tenant; authorization is scoped; a foreign id is indistinguishable from a missing one.
- `image-asset-registry`: every read and write is tenant-scoped; deduplication does not cross tenants; quota is accounted per tenant.

## Impact

**Code:** `packages/db` (schema, migration, repository), `apps/api` (guard, every controller and service), `infra/cdk/lib/config.ts` (deployment manifest). No change to `packages/core`, `infra/cloudfront`, `apps/generator`, `packages/client`, `examples/`.

**Data:** one new table, one nullable-then-backfilled column on assets and keys, one migration with a single-tenant backfill.

**Operations:** a second deployment doubles the fixed cost floor (NAT gateway, RDS instance, Fargate baseline). Around the eleventh deployment, CloudFront account quotas on key groups and cache policies become the wall — noted in tasks, not solved here.

**Deliberately out of scope:** per-tenant encryption keys, per-tenant rate limits at the edge, and cross-tenant asset sharing.
