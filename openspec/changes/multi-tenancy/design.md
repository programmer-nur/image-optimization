## Context

`design.md` D1 records single-tenancy as a Non-Goal: one deployment per project, no `tenant_id` anywhere. That decision bought a great deal — no scoping to forget on any query, no tenant dimension on any metric, and a delivery plane that reads no database at all.

The owner now needs one installation to serve several applications. This document records what was chosen, and what was rejected, because the rejected options are the expensive part: **the URL space is free exactly once.** Delivery URLs are immutable and cached for a year (D8), so a tenancy scheme baked into the path can never be taken back out without re-minting every URL every consumer has published.

Three designs were developed independently and judged against the invariants in CLAUDE.md.

## Goals / Non-Goals

**Goals.** Serve several applications from one installation. Close the ownership holes that exist today. Keep every option open until a deployment has actually run.

**Non-Goals.** Confidentiality of delivery URLs — they are unauthenticated by design and this change does not alter that. Cross-tenant asset sharing. Per-tenant encoder epochs. Per-tenant edge rate limits.

## Decisions

### T1 — Tenancy is the deployment, not a path segment

**Decision:** a second application is a second deployment. `config.name` is the tenant identity; hostnames separate tenants. `ENVIRONMENTS` becomes a deployment manifest.

**Why:** it is the only option that costs nothing irreversible. URL grammar, canonical key, storage prefixes, edge normalizer, and client SDK are untouched — zero diff in `packages/core` and `infra/cloudfront`, so the generated edge artifact stays byte-identical and the drift gate keeps passing without a regeneration commit.

**What it costs:** a fixed floor per deployment — NAT gateway, RDS instance, Fargate baseline. At two or three applications that is the honest price of not guessing. It stops being viable around the eleventh deployment, where CloudFront account quotas on key groups and cache policies bite; T3 records where that wall is.

### T2 — The registry gains a tenant column now, with one tenant per deployment

**Decision:** land `tenantId`, a `Tenant` table, and a scoped repository immediately — in a deployment that has exactly one tenant, where it changes no behaviour at all.

**Why this is the highest-value move in the whole analysis:** it is a runtime no-op and a permanent structural guarantee. Today's ownership holes are real at N=1 (any key can read, replace, or delete any asset, and quota is charged to whichever key created an asset rather than to the caller). More importantly, it preserves the option: collapsing several single-tenant deployments into one shared deployment later is then a data migration and a DNS repoint, not an audit of every route under time pressure.

**Why the collapse is safe:** the distribution's cache policy sets `headerBehavior: none()`, so `Host` is not a cache dimension; and asset ids are globally unique ULIDs, so `derived/{assetId}/…` from two independent deployments cannot collide. Merging is therefore: copy objects into one bucket (no key collisions), migrate rows with distinct `tenantId`s (the column is already there), add both hostnames as alternate domain names on one distribution. **Zero URL changes, zero re-mint, zero invalidation.**

**Enforcement, not discipline:** the scope is a branded type obtained from an authenticated request. A repository method cannot be called without one, so a new endpoint that forgets scoping fails to compile rather than reading across tenants. Jobs that legitimately span tenants — reclamation — use a separately named, lint-restricted unscoped path, so its use is visible in review.

### T3 — Tenancy stays out of the URL and the key

**Decision:** rejected — `/i/{tenant}/{id}/{version}` and `derived/{tenant}/…`.

**Why rejected:** it is the only design that spends the one-time free change to the URL space, and it buys operational capabilities — per-tenant lifecycle rules, prefix-scoped human roles, per-prefix invalidation — that a two-tenant deployment cannot yet evaluate the need for. Its confidentiality benefit is nil: delivery is unauthenticated either way. Once a consumer ships, the path is frozen for a year minimum, and every later structural regret becomes an encoder-epoch event.

It also touches the one line where edge/core drift is possible — the URI rewrite — and it would introduce a new value both implementations must agree on (the tenant regex). The shared conformance vectors do not cover path shape at all (`ConformanceVector` is `{query, accept?, expected}`; the path is exercised only by hand-written assertions with a hardcoded asset id), so the change would land in the one area the drift oracle structurally does not check.

**What would reverse this:** a consuming application needing per-tenant object lifecycle, per-tenant IAM for human operators, or the ability to suspend one tenant's delivery by bucket policy. None applies yet.

### T4 — The fleet manager is deferred

**Decision:** the per-deployment topology is adopted; the machinery that would automate it — a fleet driver, shared cell stacks, a reduced "lite" profile — is not built.

**Why:** at two tenants a fleet manager manages two things, while holding credentials that can destroy every tenant. Its own cost analysis puts the saving at roughly $320/month at a hundred tenants, which is not the scale in question. The subset that matters on day one — a second deployment, tenancy in the hostname — needs none of it.

## Risks / Trade-offs

- **Discipline risk on the scope type.** A branded type is enforcement, but only while nobody adds an escape hatch. _Mitigation:_ the unscoped repository is separately named and lint-restricted, and a parameterized test enumerates every repository method and every route.
- **Two deployments cost roughly twice one.** Accepted deliberately; it is the price of not freezing the URL space on a guess.
- **The eleventh deployment hits CloudFront quotas** with a `LimitExceeded` naming a resource nobody associates with deployment count. _Mitigation:_ recorded as a task to check before the third deployment, not after the tenth.
- **The conformance path gap remains.** Worth closing regardless of which tenancy design eventually wins, and listed as a task.

## Migration Plan

Ordered so that each step is independently valuable and none is blocked on a decision that has not been made yet.

1. Fix the quota-subject defects first, separately, so they are not misread as tenancy bugs in review. _(Done — the caller now pays, with a regression test.)_
2. Turn `ENVIRONMENTS` into a deployment manifest and add the second entry. Synthesis proves both.
3. Deploy the first installation. **Nothing about tenancy should be decided before one deployment has actually run** — every claim about runtime AWS behaviour in `infra/cdk` is currently reasoned, not observed.
4. Deploy the second. The second application is onboarded, and this change has delivered its purpose.
5. Land the tenant table, the column, and the scoped repository, with one tenant row per deployment.
6. Before the third deployment, check CloudFront account quotas.

## Open Questions

- **Does any consuming application need images that are not readable by URL alone?** If yes, that is a separate change with a distinct key space chosen at ingest, and it would also reopen T3. Nothing in the current requirements says yes.
- **Where is the boundary between "several deployments" and "one shared deployment"?** The migration path is URL-preserving, so this can be answered with real cost and operations data rather than in advance.
