# Platform Brief — Reconciliation and Forward Plan

**Date:** 2026-08-16 · **Status:** feature-complete locally, never deployed · **Decisions taken by owner:** multi-tenancy commissioned, first AWS deploy is the next milestone.

This document reconciles the original 50-section platform brief against what exists in this repository, records where the implementation deliberately diverges and why, and defines the two forward workstreams. It indexes into the sources of truth rather than duplicating them: `openspec/changes/image-optimization-service/design.md` (decisions D1–D17), the 12 spec files, `tasks.md`, and `docs/`.

---

## 1. Verdict

The platform the brief describes **already exists in this repository**. All 14 task groups are implemented; 867 unit and 153 integration tests pass; both planes run end-to-end locally (a URL normalizes at the edge to a canonical key, the generator renders and persists exactly that key, the next request is a storage hit). Five tasks remain open — four (9.15, 12.9, 13.7, 14.7) blocked on an AWS account, one (14.8) deliberately parked on a release decision.

Two things separate the repo from the brief:

1. **Multi-tenancy (brief §17) was explicitly excluded** — `design.md` Non-Goals: _"One deployment serves one project. No `tenant_id`, no per-tenant quotas, no tenant routing. Cross-project reuse happens by deploying another copy."_ The owner has now commissioned multi-tenancy → Workstream B.
2. **Nothing has ever been deployed.** Every claim about runtime AWS behaviour is reasoned, not observed → Workstream A.

## 2. Brief → implementation index

Status legend: ✅ built as asked · 🔷 built, deliberately different (see §3) · ⛔ not built.

| Brief § | Topic                                                   | Status | Where to look                                                                                                                                                                                   |
| ------- | ------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1, 4    | Overall concept, two-plane architecture                 | ✅     | `design.md` D1; `docs/architecture.md`                                                                                                                                                          |
| 6       | Upload: presigned PUT/multipart, staging, expiry, abort | ✅     | D2; `apps/api/src/modules/upload` — `POST /v1/images`, `POST /v1/images/uploads`, `POST /v1/images/uploads/:id/complete`                                                                        |
| 7       | Originals private, write-once, source of truth          | ✅     | Invariants in `CLAUDE.md`; lifecycle rules in group 13                                                                                                                                          |
| 8       | Async pipeline with states, non-blocking upload         | ✅     | `apps/optimizer` (SQS Lambda); `AssetStatus` enum in `packages/db/prisma/schema.prisma`; upload response never waits on processing                                                              |
| 9       | Sharp: idempotent, deterministic, memory-safe           | ✅     | `packages/core` `./pipeline` — `.rotate()` before `.resize()`, `limitInputPixels` always set, metadata stripped, displayed-not-stored dimensions                                                |
| 10      | Width buckets, snap-up, DPR folding                     | ✅     | D3; `packages/core/src/breakpoints.ts` — ladder is exactly the brief's list: 320…3840; height never snapped (aspect quantized); `dpr` folds into width                                          |
| 11      | URL transforms + normalization                          | ✅     | Transform grammar + canonical key in `packages/core`; inert parameters elided; canonical key = CDN cache key = S3 key                                                                           |
| 12      | Dynamic transformation architecture                     | 🔷     | D5, D9 — CloudFront Function normalizes only; Sharp runs in a regular Lambda behind origin failover. Not Lambda@Edge (as the brief warned)                                                      |
| 13      | Lazy vs pre-generated                                   | ✅     | D6, D7 — hybrid: small eager warm set, everything else lazy and persisted; master renditions conditional on source size. Matches the brief's stated preference                                  |
| 14–15   | CDN, cache keys, versioning, invalidation               | ✅     | D8 — immutable URLs `{assetVersion}-{encoderEpoch}`; invalidation only for takedowns                                                                                                            |
| 16      | Database schema                                         | 🔷     | `packages/db` — `Asset` / `AssetVersion` / `Derivative` / `ApiKey` (brief's Image/ImageVariant under different names, plus explicit versioning); no Tenant table yet                            |
| 17      | Multi-tenancy                                           | ⛔     | Recorded Non-Goal. Commissioned now — see §5                                                                                                                                                    |
| 18      | API keys, hashing, rotation, revocation                 | ✅     | `apps/api/src/modules/auth` — `imgk_<id>_<secret>`, SHA-256 stored, timing-safe compare, plaintext shown once, `DELETE /v1/keys/:id` revokes                                                    |
| 19      | Scoped permissions                                      | 🔷     | Coarse `permissions[]` per key (`upload`, `delete`, `admin`) + per-key quotas (`maxBytes`/`maxAssets`), not the brief's six scopes — see §3.5                                                   |
| 20      | Delivery security, OAC, private buckets                 | ✅     | D12; delivered bytes are always re-encoded pipeline output — source bytes never pass through                                                                                                    |
| 21      | File security: magic bytes, bombs, malware              | ✅     | Group 11; staging-then-promote validation; `limitInputPixels`; dual malware-scan flags wired to GuardDuty provisioning in CDK                                                                   |
| 22      | Versioned REST API, DTOs, errors, pagination            | ✅     | `docs/api-reference.md`; assets controller: get/list/patch/replace-source/reprocess/delete                                                                                                      |
| 23      | Idempotency                                             | ✅     | Canonical key is the idempotency key by construction; S3 conditional writes; `parseVariantName` re-serializes and compares                                                                      |
| 24      | SQS design, DLQ, retries                                | ✅     | `packages/queue`; a failed enqueue never fails an upload                                                                                                                                        |
| 25–26   | Lambda sizing, packaging, large images                  | ✅     | D10; 3008MB is a labelled starting guess pending 14.7 power tuning (`docs/tuning.md`)                                                                                                           |
| 27–29   | CDK stacks, environments, best practices                | ✅     | `infra/cdk` — Network/Storage/Data/Queue/Compute/Cdn split by lifecycle; `infra/cdk/README.md`; synthesis-tested (`pnpm --filter @imgopt/infra test`)                                           |
| 30–31   | Secrets, AWS credentials                                | ✅     | `docs/bootstrap.md` prerequisites and config steps                                                                                                                                              |
| 32      | Observability                                           | ✅     | D17; `packages/metrics` (EMF) — alarms import `METRICS`/`DIMENSIONS` constants so a typo cannot silently disarm an alarm                                                                        |
| 33–34   | Cost model, cleanup                                     | ✅     | D16 (worked numbers — bandwidth ≈ 75% of cost); `apps/maintenance` — orphan reconciliation, superseded-version expiry, upload reaping, storage accounting; fails toward keeping                 |
| 35–37   | Frontend integration, SDK strategy                      | ✅     | Core product is REST + CDN; `packages/client` — `.` framework-agnostic (React optional peer → React Native-compatible), `./react`, `./next`; `examples/nextjs` prerenders for markup inspection |
| 38      | Developer experience                                    | ✅     | `docs/bootstrap.md` §7–8: deploy → create key → upload → URL                                                                                                                                    |
| 39      | Structured errors                                       | ✅     | `docs/api-reference.md`                                                                                                                                                                         |
| 40      | Testing                                                 | ✅     | 867 unit / 153 integration; shared conformance vectors replay against both core and the generated edge function; coverage gates 90/85 on core                                                   |
| 41–42   | Performance targets, scaling analysis                   | 🔷     | D16 analysis done; load-test script written (`infra/cdk/scripts/load-test.ts`) but **never run** — targets unvalidated until deployment                                                         |
| 43      | Repo structure                                          | ✅     | D14 — as the brief sketch, plus `apps/generator` and `apps/maintenance` split out                                                                                                               |
| 44–45   | Documentation, Mermaid diagrams                         | 🔷     | 7 docs exist; Mermaid only in `architecture.md`. Minor gap: flow diagrams for upload/processing/failure could be added                                                                          |
| 46      | Implementation phases                                   | ✅     | `tasks.md` groups 1–14 map onto the brief's 12 phases                                                                                                                                           |
| 47      | Engineering rules                                       | ✅     | "Invariants that are easy to break" in `CLAUDE.md`                                                                                                                                              |
| 48      | Production-readiness audit                              | ⛔     | **Cannot honestly pass before a deployment exists.** `docs/operations.md` is the runbook; observation required                                                                                  |

## 3. Deliberate divergences from the brief, and why

1. **Generation happens on cache miss at the delivery plane, not only via S3-event fan-out.** The brief's diagram pre-generates via S3 event → SQS → Lambda. As built, the API enqueues a small warm set (D6) and everything else is generated on first request by a Function-URL Lambda behind CloudFront origin failover (D5), then persisted to exactly the canonical key. This _is_ the hybrid the brief's §13 preferred — it bounds storage to variants actually requested while keeping every later request a cache/S3 hit.
2. **The edge function is generated code.** `packages/core` defines normalization; `infra/cloudfront/generate.mjs` emits the CloudFront Function from it. Divergence between edge cache key and generator output would be a silent 100%-miss failure mode, so it is made structurally impossible rather than reviewed for (D4). Never hand-edit `normalize.generated.js`.
3. **Quality is perceptual, not a raw codec value.** `?q=75` maps per-codec (mozjpeg 78 / WebP 72 / AVIF 50). Passing `q` straight through would make AVIF near-lossless and forfeit the format's size advantage — the platform's main cost lever.
4. **Schema naming:** brief's `Image`/`ImageVariant` are `Asset`(+`AssetVersion`)/`Derivative`. The extra version entity is what makes §15's immutable-URL strategy first-class.
5. **Coarse permissions instead of six scopes.** With a single tenant, `upload`/`delete`/`admin` plus per-key quotas cover the real privilege boundaries; key administration itself requires `admin`. The multi-tenancy change is the right moment to widen this (per-project scoping makes finer scopes meaningful).
6. **No `GET /projects/:id/usage`** — meaningless single-tenant. Usage exists as per-key counters (`usedBytes`/`usedAssets`), the storage-accounting maintenance job, and CloudWatch. The endpoint arrives with Workstream B.

## 4. What "feature-complete" does not include

No deployment has ever happened; there are no AWS credentials on this machine. Concretely open in `tasks.md`: **9.15** (staging E2E: upload → first request generates → second is a storage hit), **12.9** (induce each alarm and watch it fire), **13.7** (run the load test; it asserts the bounded-variant-space claim), **14.7** (Lambda power tuning; 3008MB is a guess), **14.8** (publish `@imgopt/client` + tag a release — parked: npm scope ownership and registry are undecided, all packages are `private: true`; decisions written up in `docs/release.md`). The §48 audit can only be completed against a live environment.

## 5. Workstream B — Multi-tenancy (commissioned)

This reverses a recorded Non-Goal, so it proceeds as a **new OpenSpec change** (`openspec/changes/multi-tenancy/`) with its own proposal/specs/design/tasks — not as silent edits. `design.md` and `CLAUDE.md` get updated by that change.

**Why it is expensive here specifically.** The canonical key is simultaneously the CDN cache key and the S3 object key, must be derivable from the URL alone (the edge has no metadata; the generator receives only the rewritten path), and must stay reversible. Tenancy therefore must live **in the URL path** — e.g. `/{project}/{assetId}/{assetVersion}-{encoderEpoch}/{variant}` — so both edge and generator derive it with zero lookups. That touches every layer that touches keys, and it is why B must land **before any production consumer freezes the URL space**: URLs are immutable and cached; retrofitting a project segment later mints a new URL space for every consumer at once.

**Impact map:**

| Layer              | Change                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`    | Key grammar gains a project segment; conformance vectors extended; reversibility check covers it                                        |
| `infra/cloudfront` | Regenerate the edge function from core (`pnpm --filter @imgopt/edge generate`); commit the artifact                                     |
| `packages/db`      | New `Project` model; `projectId` FK on `Asset` and `ApiKey`; per-project uniques; migration                                             |
| `apps/api`         | Every query scoped by the authenticated key's project; quotas move key → project; finer permission scopes; `GET /v1/projects/:id/usage` |
| Storage layout     | `staging/{project}/…`, `original/{project}/…`; derivative keys carry the project prefix                                                 |
| `apps/generator`   | Parses project from the path; still never reads the database                                                                            |
| `apps/maintenance` | Accounting and reclamation become per-project; safety posture unchanged                                                                 |
| `packages/client`  | URL builder and upload helpers take a project; **do 14.8 only after this** or the published API breaks immediately                      |
| `infra/cdk`        | Structurally unchanged (shared bucket + prefix isolation); per-project WAF keys optional later                                          |

**What does not change:** the two-plane split, bucketing, hybrid generation, immutable URLs, no-Redis, fail-toward-keeping reclamation. Tenancy is a namespace threaded through existing invariants, not a new architecture.

**Isolation model to decide in the proposal:** shared bucket + key-prefix + shared DB with `project_id` (recommended — it is what "one centralized deployment" means; isolation enforced at API and key level) versus bucket-per-project (stronger blast-radius, but CloudFront needs origin routing per bucket and the CDK stack count stops being flat). The proposal records this with alternatives, per the house style.

## 6. Workstream A — First deploy

`docs/bootstrap.md` is the complete empty-account→working-deployment runbook (install/verify locally → CDK bootstrap → build artifacts → configure → two-part first deploy → migrate → first API key → verify miss-then-hit, plus DNS and production notes). Needed from the owner: an AWS account, a region, credentials on this machine (SSO per bootstrap prerequisites; no long-lived keys), and optionally a domain for Route53/ACM — the deploy works without a custom domain first.

Then burn down, in order: **9.15** staging E2E → **12.9** alarm verification → **13.7** load test (validates cache-hit ratio and cost-per-thousand targets from D16) → **14.7** power tuning (record in `docs/tuning.md`). Exit criteria: all four checked off in `tasks.md`, and the §48 audit rerun with observed — not reasoned — answers.

## 7. Order of execution

1. **A1** — Account bootstrap + dev deploy of the system _as built_ (single-tenant). Nothing waits on B; this validates a year of reasoned AWS behaviour.
2. **B0** — Draft the multi-tenancy OpenSpec change proposal (parallel with A1); owner reviews before any implementation.
3. **A2** — Burn down 9.15 / 12.9 / 13.7 / 14.7 in staging.
4. **B1…** — Implement multi-tenancy phase-by-phase after proposal approval (core grammar → db → api → delivery → maintenance → client → docs).
5. **14.8** — Registry/scope decision and first release, **after B lands** (the client's public API changes with the project segment).

Do not onboard a production consumer between A1 and B: their URLs would be minted tenant-less and every one of them invalidated when B lands.

## 8. Top risks

| Risk                                                                             | Mitigation                                                                                                                             |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Production URLs frozen before tenancy lands → full URL-space re-mint             | Sequencing rule above; staging-only until B ships                                                                                      |
| AWS runtime behaviour (failover semantics, OAC, alarm wiring) only ever reasoned | A2 exists precisely for this; treat first deploy as verification, not ceremony                                                         |
| Edge/core drift while changing the key grammar in B                              | Generated-function discipline + extended conformance vectors; watch `OnDemandGenerationRate` staying non-zero — it is the only symptom |
| Quota semantics change (key → project) surprises existing key holders            | Migration note in the B proposal; keys keep working, limits move                                                                       |
| `@imgopt` npm scope may not be ours (14.8)                                       | Resolve scope/registry ownership before any publish; procedure in `docs/release.md`                                                    |

## 9. Definition of done — next milestone

**Workstream A:** dev + staging deployed from `infra/cdk`; 9.15, 12.9, 13.7, 14.7 checked off; bootstrap doc corrected wherever reality disagreed with it; §48 audit completed against the live environment. **Workstream B:** proposal approved by the owner with the isolation model decided; then per-phase DoD from its own `tasks.md`. "Production-ready" is claimable only after both.
