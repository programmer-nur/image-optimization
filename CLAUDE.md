# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

Feature-complete against the build plan, and never deployed. Task groups 1–14 of `openspec/changes/image-optimization-service/tasks.md` are done except the four that need an AWS account (9.15, 12.9, 13.7, 14.7) and 14.8, which needs a registry decision. The `multi-tenancy` change is implemented through group 3; its group 4 is explicitly deferred until a third deployment exists.

What exists: the pnpm workspace and tooling, `packages/core` (transform grammar, breakpoint bucketing, canonical keys, Sharp pipeline), `packages/config`, `packages/storage`, `packages/queue`, `packages/db` (Prisma schema, migrations, scoped and unscoped registries), `apps/api` (NestJS + Fastify control plane), `apps/optimizer` (SQS Lambda — warm set, metadata, LQIP, conditional master), `infra/cloudfront` (the generated edge normalizer and its conformance runner), `apps/generator` (Function URL Lambda — on-miss generation), `infra/cdk` (six stacks split by lifecycle), `infra/cloudflare` (DNS reconciliation and ACM issuance), `packages/client` (browser SDK), group 11's security hardening, `packages/metrics` with the observability stack, and `apps/maintenance` for scheduled reclamation. 990 unit tests, 175 integration.

Both planes run end to end locally: a URL normalizes at the edge to a canonical key, the generator renders and persists exactly that key, and the next request is a storage hit.

**Nothing has ever been deployed.** There are no AWS credentials, AWS CLI, or CDK CLI on this machine, so `infra/cdk` is verified only as far as synthesis — tasks 9.15, 12.9, 13.7, and 14.7 are blocked on an account. Treat every claim about runtime AWS behaviour in that package as reasoned, not observed.

`docs/` carries the architecture overview, API reference, integration guide, bootstrap guide, operations runbook, tuning knobs, and release notes. `tasks.md` is the source of truth for what exists.

**The API uses SWC as its vitest transform** (`apps/api/vitest.config.ts`), not the default esbuild. NestJS resolves class dependencies through `emitDecoratorMetadata`, which esbuild does not emit — under esbuild the app boots with every injected class `undefined` and every request 500s. `tsc` emits it in production; SWC emits it under test. Symbol-token deps still use explicit `@Inject`. If you add a package that bootstraps Nest under vitest, copy that config.

## Commands

```bash
pnpm install
pnpm typecheck          # tsc --build across project references
pnpm lint               # eslint, type-checked rules
pnpm format:check       # prettier
pnpm test               # unit only; no Docker needed
pnpm test:integration   # needs `pnpm dev:up` first
pnpm test:core          # @imgopt/core only
pnpm --filter @imgopt/core test -- breakpoints      # one test file
pnpm --filter @imgopt/core test:coverage            # thresholds: 90% lines, 85% branches
pnpm --filter @imgopt/edge generate                 # regenerate the CloudFront Function
pnpm dev:up             # postgres + minio + elasticmq
```

**The Lambda bundles must be `.mjs`, and must reach sharp through `createRequire`.** They are ESM, and a deployed function has no package.json above it — a bare `.js` is read as CommonJS and throws on its own first `import`. Renaming alone is not enough: sharp ships in a layer that Lambda exposes through `NODE_PATH`, which the ESM resolver ignores entirely, so the bundles resolve it through `scripts/esbuild-sharp-layer.mjs`. Both failures are init-time, on every invocation, with the infrastructure perfectly correct.

**`infra/cloudfront`'s conformance suite reads `packages/core/dist`, not its source.** Rebuild core (`pnpm --filter @imgopt/core build`) before running the edge tests or regenerating the artifact, or you are testing the previous grammar and it will look like it passed.

**Regenerate the edge function after any change to the transform grammar**, and commit the result — the committed artifact is what deploys. CI fails if it is stale, but only after you have pushed.

`pnpm --filter @imgopt/infra test` synthesizes every stack and is the infrastructure gate. `cdk synth` is _not_ usable here: resolving a VPC's availability zones for a concrete account is a context lookup, so the CLI needs credentials even though it deploys nothing.

`prisma migrate deploy` reads `DATABASE_URL` from the environment and does not pick up `.env`, so `pnpm --filter @imgopt/db db:migrate` needs it inline: `DATABASE_URL='postgres://imgopt:imgopt@localhost:5434/imgopt' pnpm --filter @imgopt/db db:migrate`.

**The API Dockerfile lists workspace dependencies by hand**, and pnpm will not tell you when one is missing — an absent `packages/<name>/package.json` just makes the workspace smaller, and the failure surfaces much later as an unresolved import, or as an image that builds cleanly and cannot start. When you add a package to `apps/api`, add it to both the `deps` copy list and the runtime `dist` copies. Verify with `docker --context default build -f apps/api/Dockerfile .` _and by running the image_ — a green build proves nothing here.

**Local stack ports are non-default** — MinIO on 9100/9101, Postgres on 5434 — because 9000 and 5432 are commonly already taken on a dev machine, and colliding would point tests at another project's data store. If `docker compose` cannot reach the daemon, check `docker context ls`: this machine has a stale `desktop-linux` context selected, and `docker --context default compose ...` works.

Integration specs (`*.integration.test.ts`) are excluded from `pnpm test` so CI and a fresh clone stay Docker-free; CI runs them in a separate job with service containers.

**`pnpm test:integration` runs packages one at a time** (`--workspace-concurrency=1`), and must keep doing so. Every package's integration suite shares one MinIO bucket and one Postgres database, so running them in parallel is simply invalid: `apps/maintenance` performs whole-bucket orphan collection and will delete `apps/generator`'s fixtures, which deliberately have no database rows. That surfaced as a roughly one-in-three failure with no obvious cause.

Each package carries two tsconfigs: `tsconfig.build.json` emits and excludes tests (project references point here), `tsconfig.json` includes tests for the editor and ESLint. Adding a package means adding both, plus a reference in the root `tsconfig.json`.

## Working with OpenSpec

All planning lives in `openspec/changes/<change-name>/`. Verified CLI surface (note the inconsistent flag between `status` and `validate`):

```bash
openspec list                                       # list changes
openspec status --change <name>                     # artifact completion; add --json for machine output
openspec instructions <artifact> --change <name> --json   # what to write for proposal|specs|design|tasks
openspec validate <name>                            # positional, NOT --change
openspec validate --changes                         # validate all
openspec show <name>
openspec archive <name>                             # after implementation, folds specs into openspec/specs/
```

Slash commands `/opsx:propose`, `/opsx:apply`, `/opsx:update`, `/opsx:archive`, `/opsx:explore`, `/opsx:sync` wrap these workflows.

Spec files use a strict format the parser depends on: `### Requirement:` headers, scenarios at **exactly four** hashtags (`#### Scenario:`), WHEN/THEN bullets, SHALL/MUST. Three hashtags fails silently. Tasks must be `- [ ] X.Y description` or apply-phase progress tracking will not see them.

## What is being built

A self-hosted image optimization service on AWS — the Cloudinary/Imgix model, deployed one copy per consuming project. NestJS control plane for ingest and metadata; S3 + CloudFront for delivery; Sharp in Lambda for pixel work.

`openspec/changes/image-optimization-service/design.md` is the architecture source of truth — 17 numbered decisions (D1–D17), each with alternatives and rationale. Read it before making any structural choice. The 12 spec files under `specs/` define required behavior; `tasks.md` is the ordered build plan.

### The shape that matters

Two planes that never touch:

- **Control plane** — NestJS on ECS Fargate. Uploads, validation, metadata, lifecycle. Stateful, rare, database-backed.
- **Delivery plane** — CloudFront Function normalizes the request and rewrites the URI → S3 serves the derivative if it exists → on 403/404 CloudFront fails over to a Sharp Lambda, which generates it, writes it to that exact S3 key, and returns it. Every later request is a cache or S3 hit.

The control plane is **never** in the image read path, and the delivery path **never** queries PostgreSQL. S3 object existence is the sole authority for whether a derivative can be served.

### Layout

```
packages/core     EXISTS. transform grammar, breakpoints, canonical key — ZERO AWS imports
                  ./pipeline subpath holds the sharp code; root stays browser-safe
packages/config   EXISTS. zod-validated deployment config, shared by API and both Lambdas
packages/storage  EXISTS. StoragePort + S3 adapter; MinIO is the same adapter with an endpoint override
packages/queue    EXISTS. QueuePort + SQS adapter; separate from storage for Lambda bundle size
packages/metrics  EXISTS. CloudWatch EMF emission. The alarms import METRICS/DIMENSIONS
                  from here rather than re-declaring them — a misspelled metric name
                  leaves an alarm in INSUFFICIENT_DATA, which reads as healthy
packages/db       EXISTS. Prisma schema + migrations; generated client in src/generated (gitignored).
                  Two faces on the registry: TenantScopedRepository, whose every method takes a
                  branded TenantScope, and UnscopedAssetRepository, which spans the deployment
                  and is lint-restricted to the three workers
apps/api          EXISTS. NestJS control plane → Docker → Fargate
apps/optimizer    EXISTS. SQS-triggered Lambda: warm set, metadata, conditional master
apps/maintenance  EXISTS. Daily EventBridge Lambda: orphan reconciliation, superseded-version
                  expiry, upload reaping, storage accounting. Holds the only role permitted
                  to delete an original outside the API's explicit DELETE endpoint (the
                  Fargate task role also carries original/* delete for that path), so every
                  job is written to fail toward keeping
apps/generator    EXISTS. Function URL Lambda: on-miss generation. No SQS. Never *reads*
                  the database; the handler injects a best-effort bookkeeping write that
                  generator.ts treats as optional and whose failure it swallows
infra/cloudfront  EXISTS. @imgopt/edge — normalize.template.js is hand-written,
                  normalize.generated.js is emitted by generate.mjs and never hand-edited,
                  conformance.test.mjs replays the shared vectors against both
infra/cdk         EXISTS. @imgopt/infra — Network / Storage / Data / Queue / Compute / Cdn.
                  DEPLOYMENTS in lib/config.ts is the manifest; a tier is only a sizing profile.
                  All security groups live in the network stack, and the CDN stack imports
                  the bucket by name; both avoid cross-stack cycles that CloudFormation
                  reports as walls of unrelated resources. Creates NO DNS records and
                  issues NO certificates. See infra/cdk/README.md
infra/cloudflare  EXISTS. @imgopt/cloudflare — DNS reconciliation and ACM issuance, kept
                  outside the CDK because CloudFormation cannot write a zone it does not
                  own. Reads CdnDnsTarget/ApiDnsTarget from stack outputs, diffs against
                  the zone, prints a plan, writes only with --apply. See D18
packages/client   EXISTS. Three entry points — `.` framework-agnostic, `./react`, `./next`.
                  `sizes` selects the candidate set, not just the attribute: viewport-scaled
                  images get device rungs, fixed-size ones the 1x/2x rungs
examples/nextjs   EXISTS. Hero, gallery, avatar cases; prerenders statically so the
                  emitted markup can be inspected directly
```

Transform _grammar_ lives in `packages/core` as constants; deployment _settings_ live in `packages/config` as env. The split matters: ladder values, quality levels, and encoder defaults are baked into cached URLs, so changing one is an encoder-epoch event, not a redeploy knob.

## Invariants that are easy to break

These are not discoverable by reading code, and violating any of them is expensive to undo once assets are cached at the edge.

**Edge and core must agree on normalization.** `packages/core` defines the width ladder and canonical-key construction; the CloudFront Function is _generated_ from it. If they ever diverge, CloudFront computes cache key A while the Lambda writes object B — permanent 100% miss, every request invoking Lambda, and **nothing appears in error rates**. Never hand-edit the generated edge function. The shared conformance vectors must pass against both implementations, and the `OnDemandGenerations` metric staying non-zero is the only symptom you will get.

**The canonical key is simultaneously the CDN cache key and the S3 object key.** They are the same string by construction, not kept in sync by convention.

**The canonical key must stay reversible.** The generator receives only the rewritten path — no query string, no database — so everything needed to reproduce the bytes has to be recoverable from the key alone. Rare parameters (gravity, background, blur, sharpen) are spelled out in a fixed order rather than hashed for exactly this reason; `parseVariantName` re-serializes what it parsed and compares before accepting. A key component that cannot be parsed back makes every request carrying it fail permanently, and only for the rare parameters nobody tests by hand.

**Every output width comes from the ladder.** Snap _up_ (never serve fewer pixels than requested). An unbucketed width anywhere means unbounded S3 objects, a permanently cold cache, and an amplification vector. Enforced in two places, and it needs both: the edge refuses a raw `/derived/…` path so the normalizer cannot be skipped, and `parseVariantName` refuses a width off the ladder, a height the ratio quantizer cannot produce, and a background off the channel grid — the id, version, and epoch are visible in every public URL, so a derivative path can always be _constructed_. `capToSource` floors at the smallest rung for the same reason: a key at a tiny source's native width is one no viewer URL can ever ask for.

**The source-width cap applies to pixels, not to the key.** The edge normalizer has no asset metadata — no network, and CloudFront KeyValueStore is far too small for millions of assets — so it cannot know a source's intrinsic width. The key is therefore derived from the URL alone, identically at the edge and in the generator, which is what makes drift structurally impossible. `?w=3840` on a 2000px source yields key `w3840_…` holding 2000px-wide bytes. `snapWidth` takes an optional `sourceWidth` for the SDK, which caps its `srcset` candidates so oversized buckets are never requested in practice.

**Height is never snapped to the width ladder** — the aspect ratio is quantized instead. Snapping height directly turns a `640×481` request into `640×640`.

**Inert parameters are elided from the key.** A parameter that is present but cannot affect the output fragments the cache exactly as badly as an unquantized one: `?w=640` and `?w=640&fit=cover` must produce one key. `fit` survives only when _both_ dimensions are constrained, `background` only on `contain` (and `pad` is a request-time spelling of `contain`, not a mode of its own), gravity only on `cover` — `outside` resizes past the box and returns it whole, so sharp never crops it — and effects only above level 0.

**Every key axis is quantized, including the ones that look like free-form strings.** Background channels snap to the 4-bit grid (`00, 11, … ff`); unquantized, that one parameter is 2^24 keys per box, each a render and a permanent object. `crop=focal` is absent for a related reason: a focal point lives in the registry, the delivery plane never reads the registry, so it rendered as centre and minted a duplicate key. The stored focal point is advisory metadata only.

**`dpr` folds into width before snapping** and never becomes its own cache dimension.

**Absolute pixel crops are not expressible in a delivery URL.** `crop=x,y,w,h` reintroduces an unbounded key space and undoes bucketing single-handedly. Public `crop` takes named gravity only; arbitrary rectangles mint a new asset through the authenticated API.

**Originals are write-once.** No code path reads an object under `original/`, modifies it, and writes it back. Replacing source bytes mints a new asset version at a new key.

**The bucket is versioned, so a delete is a delete marker.** That is the safety net under originals, which cannot be regenerated and which two roles can delete. It also means every lifecycle rule needs its own noncurrent expiry — without one on `staging/`, the hard expiry and the malware quarantine handler both stop destroying unvalidated bytes and start retaining them. Never grant `s3:DeleteObjectVersion` to a service role: that would defeat the net using the same code path that caused the incident.

**Uploads are validated in `staging/` before promotion to `original/`.** Direct-to-S3 uploads physically cannot be validated pre-storage; the staging prefix is what reconciles "validate first" with "never fail on large files". Nothing under `staging/` is CDN-reachable.

**Upload response never waits on processing**, and a failed enqueue never fails an upload.

**`.rotate()` precedes `.resize()`** in the Sharp pipeline. Reversed, an EXIF-orientation-6 photo is resized against its stored landscape dimensions and comes out wrong.

**Quality is a perceptual scale, not a raw codec value.** `encoder-options.ts` maps each nominal level onto per-codec settings — nominal 75 is mozjpeg 78, WebP 72, AVIF 50. Passing `q` straight to the encoder would make `?q=75` near-lossless in AVIF and forfeit the size advantage that is the system's main cost lever.

**`readMetadata` reports displayed dimensions, not stored ones.** Orientations 5–8 transpose the axes. Sharp's own `metadata()` returns stored values; passing those through gives clients a transposed aspect ratio, layout shift, and `srcset` capped on the wrong axis.

**Test widths must be ladder rungs.** A test asking for `w=200` gets 256 — the parser snaps before anything else runs. Several of my early test failures were this, not real bugs.

**EXIF orientation fixtures need `withMetadata({ orientation })`, not `withExif`.** sharp special-cases the tag: writing it through `withExif` produces EXIF that reads back as orientation 1, so the fixture silently tests nothing.

**`limitInputPixels` is always set.** A 30KB PNG can decode to tens of gigabytes.

**Delivered bytes are always re-encoded pipeline output** — source bytes are never passed through to viewers. That, not detection, is what defeats a polyglot.

**Environment booleans are parsed by spelling, never coerced.** `z.coerce.boolean()` is `Boolean(value)` and every environment variable is a string, so `"false"` coerces to _true_ — and the CDK writes exactly that string. That turned `UPLOAD_MALWARE_SCAN_ENABLED=false` into "a scanner exists", which with fail-closed holds every upload forever, and `MAINTENANCE_DRY_RUN=false` into a reclamation job that never deletes. Use the `bool` helper in `packages/config/src/config.ts`; an unrecognized spelling must fail rather than pick a side.

**Malware scanning has two independent switches.** `UPLOAD_MALWARE_SCAN_ENABLED` says a scanner exists; `UPLOAD_FAIL_CLOSED_ON_SCAN_UNAVAILABLE` says what to do when it has not answered. Fail-closed with no scanner provisioned holds _every_ upload forever and looks like a broken uploader. The CDK stack sets the app flag from the same value that provisions GuardDuty, so they cannot drift.

**An unavailable malware verdict holds an upload; it does not reject it.** Scanning is asynchronous, so "not scanned yet" is indistinguishable from "scanner is broken". A held upload returns 202, stays `pending_upload`, and leaves its bytes in staging, where the lifecycle rule expires them if nothing resolves it.

**Reclamation fails toward keeping objects.** The registry is not the authority on what exists: the generator writes a derivative _before_ its best-effort bookkeeping row, so a recently written object with no row is normal, not an orphan. `apps/maintenance` therefore never touches anything inside the safety window, leaves unparseable keys alone, and caps deletions per run. Shortening a window makes the job race the system it is cleaning up after, and the objects at stake include originals.

**DNS is Cloudflare's, and the proxy must stay off.** Every record is a plain CNAME with the grey cloud. Cloudflare's proxy caches by URL and honours `Vary` only for `Accept-Encoding`, while one delivery URL legitimately returns AVIF, WebP or JPEG depending on `Accept` — so an orange-clouded record caches one format and serves it to every viewer, including AVIF to browsers that cannot decode it. Broken images for a subset of users, nothing in any error metric. The reconciler in `infra/cloudflare` turns it off rather than reporting it.

**Certificates are pre-issued and passed in as ARNs.** CloudFormation can only validate a DNS-validated certificate in a hosted zone it owns; pointed at an external zone it does not fail, it _waits_ — a deploy that hangs until CloudFormation gives up. `pnpm --filter @imgopt/cloudflare certs` issues both (us-east-1 for CloudFront, deployment region for the ALB) and plants their validation records. **Those records are permanent** — ACM re-checks them to renew, so deleting one breaks renewal silently about eleven months later.

**URLs are immutable; do not invalidate CloudFront for content changes.** The version segment is `{assetVersion}-{encoderEpoch}`. Replacing bytes bumps `assetVersion`; changing encoder policy globally bumps `encoderEpoch`, minting a fresh URL space with no per-asset writes. Invalidation is for deletions and takedowns only.

**Tenancy is the deployment, and it stops at the control plane.** It appears in no URL, no
object key, and no edge computation — the delivery plane never reads the database, and the URL
space is free exactly once. A second application is a second entry in `DEPLOYMENTS`. The
`tenantId` column exists anyway at one tenant per deployment, because it is what makes a later
collapse into one installation a data migration rather than a route-by-route audit.

**The control plane can only reach the registry through a `TenantScope`.** `scopeOf(req.apiKey)`
is the only way to make one, so an endpoint that forgets to scope fails to compile rather than
reading across tenants. `UnscopedAssetRepository` is the deployment-wide face, named that way and
restricted by a `no-restricted-imports` rule to `apps/maintenance`, `apps/optimizer`, and
`apps/generator` — reclamation walks the whole bucket by nature, and the two workers act on a job
they were handed. Adding a fourth consumer is a visible edit to `eslint.config.mjs`.
`packages/db/src/tenant-scoped-repository.test.ts` enumerates the scoped methods off the
prototype, so a method added without a scoping expectation fails there.

**Another tenant's id answers 404, never 403.** A 403 confirms the id is real, which is the one
bit an enumeration attempt is trying to learn. `findById` uses `findFirst` with the tenant in the
`where` for the same reason: "fetch then compare" is the shape that gets refactored into a leak.

**Deduplication is scoped.** Matching a content hash across tenants would hand one tenant a
reference to another's asset _and_ disclose that the other holds exactly those bytes. Two
customers uploading the same stock photo is two assets and two copies, and that is correct.

**Quota is the tenant's, not the key's.** Per-key limits survive only as a ceiling that can
narrow — otherwise the way to raise an allowance was to ask for a second key. Both counters move
inside one transaction, because charging the tenant and then failing on the key would leak
allowance on every rejected upload.

**`packages/core` imports no AWS SDK.** That is what lets the transform algorithm be unit-tested in milliseconds and run unchanged in a container, in Lambda, and in a browser SDK.

## Decisions already settled — do not relitigate

Fargate for the control plane (not Lambda). Single-tenant, one deployment per project — no `tenant_id` anywhere. CloudFront Function + S3 origin + Lambda failover (not Lambda@Edge, not S3 Object Lambda). AWS CDK in TypeScript. Prisma ORM (chosen by the user; D11 records why Prisma 7 removing the Rust query engine makes the original Lambda-footprint objection moot). Hybrid generation: a small eager warm set, everything else lazy and persisted. `master/` renditions conditional on source size, not always. **No Redis** — SQS queues, CloudFront caches, WAF rate-limits, S3 conditional writes suppress duplicate work; D11 records the specific condition that would reverse this.

Rationale and alternatives for each are in `design.md`. Open questions are listed there too — those are genuinely unresolved and worth raising.

## Orientation

Bandwidth is roughly 75% of the running cost (D16 has worked numbers). Modern-format adoption is therefore the highest-leverage optimization in the system, and Lambda micro-optimization is close to irrelevant by comparison. Because derivatives persist and the variant space is bounded, compute tracks _new assets_, not traffic.
