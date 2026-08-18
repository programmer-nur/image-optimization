# Multi-tenancy

Ordered so each group is independently valuable. Groups 1 and 2 need no AWS account; group 3 does.

## 1. Correctness fixes that stand alone

Landed first and separately, so they are not misread as tenancy bugs in review.

- [x] 1.1 Charge quota to the calling key on `PUT /v1/images/:id/source` and `POST /v1/images/uploads/:id/complete`, not to whichever key created the asset — any key holding `upload` could otherwise spend another key's allowance while never touching its own
- [x] 1.2 Add a regression test asserting _who was charged_ by reading both counters, rather than by exhausting a limit — verified to fail against the previous behaviour
- [x] 1.3 Close the conformance path gap: `ConformanceVector` carries no `uri`, so the delivery path shape is exercised only by hand-written assertions with a hardcoded asset id. Worth doing whichever tenancy design eventually wins, because it is the one part of the edge the drift oracle does not cover

## 2. Deployment as the tenant boundary

- [x] 2.1 Turn `ENVIRONMENTS` in `infra/cdk/lib/config.ts` into a deployment manifest, so adding an application is adding an entry rather than editing a staging/production pair
- [x] 2.2 Add a second entry and assert both synthesize in `infra/cdk/test/stacks.test.ts`
- [x] 2.3 Document onboarding an application in `docs/bootstrap.md`: what is per-deployment (bucket, database, distribution, hostnames, certificates, Cloudflare records) and what is shared (nothing)
- [x] 2.4 Record the fixed cost floor per deployment in `docs/tuning.md`, from the real values in `config.ts`

## 3. The registry gains a tenant — one row per deployment

Independently valuable at N=1: it closes ownership holes that exist today, and it is what makes a later collapse into one shared deployment a data migration rather than a route-by-route audit.

- [x] 3.1 Add a `Tenant` model and a `tenantId` column on `Asset` and `ApiKey`, with composite indexes leading on `tenantId` — every existing index that a list query uses must lead with it or the query scans across tenants
- [x] 3.2 Write the migration with a single-tenant backfill: create one tenant, attribute every existing asset and key to it, then make the column non-null. **Verify the backfill on a populated database**, as the `supersededAt` migration was
- [x] 3.3 Introduce a branded `TenantScope` obtainable only from an authenticated request, and a `TenantScopedRepository` whose methods require one — so a new endpoint that forgets scoping fails to compile. Landed without the planned `everyTenant()` escape hatch: a wildcard scope has to be a sentinel, and a sentinel used as a filter value matches nothing, so it would have returned an empty result rather than every row. Deployment-wide work uses the unscoped repository, which asks for no scope at all
- [x] 3.4 Name the unscoped repository explicitly and restrict it by lint rule to the jobs that legitimately span tenants (reclamation), so its use is visible in review
- [x] 3.5 Scope every read and write: `findById`, `list`, `listDerivatives`, `updateMetadata`, `replaceSource`, `reprocess`, `delete`, and the upload paths
- [x] 3.6 Answer `404`, never `403`, for an id owned by another tenant — a `403` confirms the id exists, which is the bit an enumeration attempt wants
- [x] 3.7 Scope `findByContentHash` so deduplication cannot return another tenant's asset, and cannot disclose that another tenant holds those bytes
- [x] 3.8 Move quota accounting from the key to the tenant, so issuing a second key does not double an application's allowance. **BREAKING** for any deployment treating per-key limits as the accounting unit. Per-key limits are retained as a secondary ceiling that can only narrow; both counters are still incremented, in one transaction, so a partial reservation cannot leak allowance
- [x] 3.9 Add a parameterized test enumerating every repository method and every route, asserting each is scoped — the guarantee is only as good as its coverage. `packages/db/src/tenant-scoped-repository.test.ts` enumerates the methods from the prototype at runtime, so a method added later fails until it is classified; verified to fail on 7 methods when the filter is removed from `findById`. Route coverage is in the integration test below
- [x] 3.10 Add an integration test that two tenants with identical bytes get two assets, and that each is invisible to the other through every endpoint

## 4. Before the third deployment

- [ ] 4.1 Check CloudFront account quotas — each deployment creates its own cache policy, response-headers policy, function, and (with private delivery) public key plus key group. The wall arrives around the eleventh deployment for key groups and the twenty-first for policies, as a `LimitExceeded` naming a resource nobody associates with deployment count
- [ ] 4.2 Revisit whether a shared deployment is now worth its complexity, using observed cost and operational load rather than an estimate
