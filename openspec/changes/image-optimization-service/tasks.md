## 1. Foundations

- [x] 1.1 Initialize pnpm workspace monorepo with `apps/`, `packages/`, `infra/` and root TypeScript project references
- [x] 1.2 Configure shared tsconfig base, ESLint, Prettier, and strict compiler options across all packages
- [x] 1.3 Set up Vitest with coverage thresholds for `packages/core` (Jest for the API arrives with the Nest scaffold in 6.1)
- [x] 1.4 Add CI workflow: install, typecheck, lint, unit tests, build — running on every push
- [x] 1.5 Create `docker-compose.yml` with PostgreSQL, MinIO, and ElasticMQ for local development
- [x] 1.6 Write `.env.example` and a zod-validated config schema module shared by all components (`packages/config`)
- [x] 1.7 Add a README stub covering local setup and the workspace layout

## 2. Core Domain — Transform Grammar and Bucketing

- [x] 2.1 Define the width ladder in `packages/core/src/breakpoints.ts` with icon widths 16–256 and device widths 320–3840
- [x] 2.2 Implement `snapWidth(requested, dpr, sourceWidth?)`: clamp to ladder max, snap up, then cap at the largest ladder value not exceeding source width when known (`sourceWidth` is optional — the edge has no asset metadata; see design.md D3)
- [x] 2.3 Implement aspect-ratio quantization against the fixed ratio set with tolerance, plus bounded-precision fallback
- [x] 2.4 Implement quality quantization to the fixed level set with per-format defaults
- [x] 2.5 Implement effect quantization for blur and sharpen, and hex normalization for background
- [x] 2.6 Define the `TransformSpec` type and parser covering `w`, `h`, `q`, `fit`, `format`, `crop`, `background`, `blur`, `sharpen`, `dpr` (hand-written rather than zod, so the generated edge twin stays comparable — rationale in the module header)
- [x] 2.7 Implement parameter policy: clamp out-of-range numerics, reject invalid enums, ignore unknown parameters, reject absolute pixel crop rectangles
- [x] 2.8 Implement `toCanonicalKey(spec)` producing the readable `w{W}_h{H}_{fit}_q{Q}` form, with rare parameters spelled out in a fixed order (originally a base36 hash; made reversible in 8.12, because the generator recovers the render from the key alone)
- [x] 2.9 Implement format-policy resolution mapping an `Accept` header plus source alpha to a concrete output format
- [x] 2.10 Write the shared conformance vector fixture covering at least 200 input/output pairs including all worked examples from `design.md` (228 vectors + 9 equivalence groups)
- [x] 2.11 Write property-based tests asserting: bucketed width is always on the ladder, never exceeds source width, is never below the requested width unless source-capped, and canonicalization is idempotent
- [x] 2.12 Write a test asserting that a sweep of every integer width 1–4000 produces no more distinct canonical keys than the ladder size
- [x] 2.13 Elide inert parameters from the canonical key (`fit` unless both dimensions are constrained, `background` on non-padding fits, gravity when no crop occurs, zero-level effects) — added during implementation; already covered by tests, kept here for traceability

## 3. Core Domain — Sharp Pipeline

- [x] 3.1 Implement the pipeline builder applying `rotate()` before `resize()`, with `limitInputPixels` and `failOn: 'truncated'`
- [x] 3.2 Implement per-format encoder option tables for JPEG, PNG, WebP, and AVIF keyed by quality level
- [x] 3.3 Implement AVIF effort reduction above the configured size threshold
- [x] 3.4 Implement alpha flattening onto the background color when targeting an opaque format
- [x] 3.5 Implement sRGB colorspace normalization and unconditional metadata stripping
- [x] 3.6 Implement `withoutEnlargement` so no output can exceed source dimensions
- [x] 3.7 Implement error classification distinguishing `corrupt_source`, `pixel_limit_exceeded`, `timeout`, and `unexpected`
- [x] 3.8 Implement LQIP generation producing a ~24px WebP as a base64 string
- [x] 3.9 Implement intrinsic metadata extraction: dimensions, format, colorspace, alpha, orientation, dominant color (reports _displayed_ dimensions, transposing for orientations 5–8)
- [x] 3.10 Add fixture images covering EXIF orientations 1–8, CMYK, wide-gamut, alpha PNG, GIF, truncated file, and non-image bytes — generated at test time rather than committed as binaries. The decompression-bomb path is exercised by lowering `maxPixels` below a small fixture instead of allocating a real bomb; animated GIF is out of scope per the proposal
- [x] 3.11 Write tests asserting orientation-6 sources resize against upright dimensions and emit no orientation tag
- [x] 3.12 Write tests asserting no EXIF or GPS data survives into any derivative
- [x] 3.13 Write a determinism test: the same source and spec produce byte-identical output across two invocations
- [x] 3.14 Make quality a perceptual scale translated per codec, rather than a raw codec value — added during implementation; passing `q` straight through would hand AVIF a near-lossless setting and forfeit its size advantage

## 4. Storage and Queue Ports

- [x] 4.1 Define `StoragePort` with head, ranged read, streaming read, streaming write, conditional write, copy, delete, and list-by-prefix (`packages/storage`)
- [x] 4.2 Implement the S3 adapter using `@aws-sdk/client-s3`, including `IfNoneMatch: '*'` conditional writes
- [x] 4.3 Implement presigned POST generation with `content-length-range` and `Content-Type` conditions, and presigned multipart part URLs
- [x] 4.4 Define `QueuePort` and implement the SQS adapter with message attributes carrying the correlation id (`packages/queue`, kept separate from storage so the generator Lambda does not bundle an unused SQS client)
- [x] 4.5 Implement the key-building module for `staging/`, `original/`, `master/`, and `derived/` prefixes — landed in 2.8 as part of `canonical-key.ts`
- [x] 4.6 Write integration tests for both adapters against MinIO and ElasticMQ (24 + 12, run via `pnpm test:integration`)
- [x] 4.7 Split unit from integration test runs and give CI service containers — added during implementation; `pnpm test` must stay runnable without Docker. Integration packages run one at a time (`--workspace-concurrency=1`): they share one bucket and one database, and `apps/maintenance` deletes `apps/generator`'s deliberately row-less fixtures when run concurrently

## 5. Database and Asset Registry

- [x] 5.1 Add Prisma ORM with the `@prisma/adapter-pg` driver adapter; configure pooling for both the container and Lambda contexts
- [x] 5.2 Define the `assets`, `asset_versions`, `derivatives`, and `api_keys` schemas per the design ER model
- [x] 5.3 Write the initial migration and wire migration execution as a standalone task entrypoint (`db:migrate`, applied and verified against local Postgres)
- [x] 5.4 Implement ULID-based asset id generation
- [x] 5.5 Implement the asset repository: create, get, list, update metadata, advance version, soft delete
- [x] 5.6 Implement status lifecycle transitions with timestamps and machine-readable failure reasons
- [x] 5.7 Implement content-hash lookup for upload deduplication (current versions only — a superseded version is history, not a duplicate)
- [x] 5.8 Write repository tests against the local PostgreSQL instance (30 integration + 15 unit)

## 6. Control Plane — NestJS Application

- [x] 6.1 Scaffold the NestJS app (Fastify adapter) with config, pino logging, and a global exception filter producing a consistent `{ error: { code, message, correlationId } }` envelope
- [x] 6.2 Implement the API-key guard with hashed verification, timing-safe compare, and per-key permissions via `@RequirePermissions`
- [x] 6.3 Implement correlation-id middleware honoring an inbound `x-correlation-id` and propagating it through an AsyncLocalStorage store
- [x] 6.4 Implement `POST /v1/images` proxied multipart upload streaming directly into staging (no full buffering)
- [x] 6.5 Implement the proxy threshold check returning `413` with guidance toward the presigned flow
- [x] 6.6 Implement `POST /v1/images/uploads` returning a presigned target and creating a `pending_upload` record
- [x] 6.7 Implement `POST /v1/images/uploads/:id/complete` performing head, ranged signature sniff, dimension check, quota check, then `CopyObject` promotion
- [x] 6.8 Implement magic-byte validation with `file-type`, rejecting declared/detected mismatches and non-accepted formats — the pixel-limit branch was fixed in 11.8: `readMetadata` _throws_ on an oversized image rather than returning its dimensions, so the explicit comparison was unreachable and the tolerant catch below accepted every decompression bomb
- [x] 6.9 Implement SVG rejection by default (undetectable-signature path); the opt-in sanitize-and-rasterize branch is stubbed to reject until 11.2 wires a sanitizer
- [x] 6.10 Implement staging cleanup on any validation failure (delete staged object, mark `rejected` with reason)
- [x] 6.11 Implement `GET /v1/images/:id` returning metadata, LQIP, intrinsic dimensions, canonical URL, and srcset
- [x] 6.12 Implement `GET /v1/images/:id/variants` listing materialized derivatives
- [x] 6.13 Implement `PATCH /v1/images/:id` for alt text, tags, and focal point, none of which changes the version (a focal point is advisory metadata: the delivery plane never reads the registry, so it cannot reach a render)
- [x] 6.14 Implement `PUT /v1/images/:id/source` minting a new asset version (dedup disabled for replacement)
- [x] 6.15 Implement `DELETE /v1/images/:id` with soft delete, prefix-scoped object removal, and CDN invalidation (no-op locally until a distribution is configured)
- [x] 6.16 Implement `POST /v1/images/:id/reprocess` re-enqueueing the warm set
- [x] 6.17 Implement `/healthz` and `/readyz` with dependency-aware readiness
- [x] 6.18 Implement per-key storage and asset-count quota enforcement via an atomic conditional update
- [x] 6.19 Ensure enqueue failure never fails an upload; log, meter, and leave the asset reconcilable
- [x] 6.20 Write e2e tests covering both ingest modes, all rejection reasons, and the full lifecycle (16 tests booting the real app against MinIO/Postgres/ElasticMQ)
- [x] 6.21 Write the multi-stage Dockerfile for the API with a non-root user and a healthcheck — **now built and run end to end.** The earlier note said verification was deferred to CI; doing it here found three defects that a green `docker build --check` had hidden: `packages/metrics` was missing from the workspace copy (pnpm does not fail on that — it just treats the workspace as smaller), `prisma generate` needs a `DATABASE_URL` it never connects to because Prisma 7 resolves it when loading the config, and `pnpm install --prod` aborts without a TTY when purging the dev `node_modules`. Verified running: `/healthz` 200, `/readyz` 503 with dependencies down, 401 on an unauthenticated upload, non-root `node` user, Docker HEALTHCHECK reporting healthy
- [x] 6.22 Configure SWC as the vitest transform so decorator metadata is emitted under test — added during implementation; esbuild does not emit it and the app would not bootstrap in tests otherwise

## 7. Optimizer Lambda

- [x] 7.1 Scaffold `apps/optimizer` as an SQS-triggered handler with an esbuild bundle for arm64 (sharp marked external → shipped via a Lambda layer; verified the bundle keeps `require("sharp")` external)
- [x] 7.2 Configure `sharp.concurrency(1)` and `sharp.cache(false)`, initializing Sharp at module scope (`sharp-init.ts`, imported first in the handler)
- [x] 7.3 Implement intrinsic metadata extraction and persistence to the asset version
- [x] 7.4 Implement LQIP generation and storage on the asset version row
- [x] 7.5 Implement conditional master generation above the configured size or dimension threshold
- [x] 7.6 Implement configurable warm-set generation — widths are _capped_ at the source (never upscale) and deduplicated, rather than skipped, so small sources still get a warm derivative; see the spec refinement below
- [x] 7.7 Implement derivative bookkeeping writes as best-effort and non-blocking
- [x] 7.8 Implement status advance to `ready`, or to `failed` with a reason on non-retriable errors
- [x] 7.9 Implement retriable-vs-terminal classification: terminal → mark failed + ack (no pointless retry); retriable → SQS partial-batch failure → redelivery → DLQ after max receive count
- [x] 7.10 Verify idempotency: processing the same message twice converges to identical state (proven — reprocessing yields no duplicate derivatives)
- [x] 7.11 Write handler tests driving the real `handler` with synthetic SQS batches against the live stack (mixed batch reports only the retriable failure); 14 integration tests total

## 8. Delivery Plane — Edge Normalizer and Generator

- [x] 8.1 Write the codegen script emitting `infra/cloudfront/normalize.generated.js` from `packages/core`, staying within the CloudFront Function size limit (`infra/cloudfront/generate.mjs`; template holds the algorithm, every table is read out of core — including the private padding/cropping fit sets and DPR bounds, derived by calling core rather than transcribed. 8230 of 10240 bytes, enforced at generation time)
- [x] 8.2 Implement the edge function: parse and validate parameters, snap width, quantize ratio/quality/effects, resolve `format=auto` from `Accept`, rewrite the URI, drop the query string and slug
- [x] 8.3 Implement edge rejection of invalid enums and unparseable values with a short-TTL client error
- [x] 8.4 Build the conformance runner executing the shared vectors against both the core library and the generated edge function (242 tests; the generated file is loaded as a bare script the way CloudFront loads it, and each vector is asserted against both its hand-written expectation and core's answer)
- [x] 8.5 Wire the conformance runner into CI so any divergence fails the build — plus a second step asserting the committed artifact is regenerable, since a stale artifact is what actually deploys
- [x] 8.6 Scaffold `apps/generator` as a Function URL handler parsing the canonical path back into a `TransformSpec`
- [x] 8.7 Implement source selection preferring the master over the original when present (head-master and list-originals issued in parallel; the original's extension is not knowable from the delivery path, and listing keeps that lookup off PostgreSQL)
- [x] 8.8 Implement generation, conditional write to the exact canonical key, and direct byte response
- [x] 8.9 Ensure generator response headers exactly match those of a stored object, including the immutable directive and `Vary: Accept` — asserted against a real `head` of the object just written. `Vary` is unconditional: the format is already concrete in the key, so neither this Lambda nor S3 can tell a negotiated response from an explicit one, and only an unconditional header keeps the two identical
- [x] 8.10 Implement non-storable error responses and guarantee no partial object is ever written
- [x] 8.11 Write tests covering: uncached variant returns 200 with correct bytes, second request bypasses the generator, concurrent generation is harmless (17 integration + 11 unit)
- [x] 8.12 Make the canonical key reversible — added during implementation. The hash suffix over rare parameters was one-way, and the generator is handed only the rewritten path, so `blur`/`sharpen`/`background`/gravity requests could never have been served. Rare parameters are now spelled out in a fixed order; see the correction recorded in design.md D3
- [x] 8.13 Reject requests whose encoder epoch is not the configured one — added during implementation. Source keys carry no epoch, so every epoch value would resolve to the same original and write a distinct object: an unbounded key space reachable from a crafted URL

## 9. Infrastructure — CDK

- [x] 9.1 Scaffold the CDK app with per-environment configuration and stack separation by lifecycle (`infra/cdk`, six stacks; 24 synthesis assertions covering both environments)
- [x] 9.2 Storage stack: bucket with Block Public Access, default encryption, deny-unencrypted-writes policy, and a retain removal policy — the deny is scoped to writes that _explicitly_ ask for something other than encryption. The obvious form, denying requests without the SSE header, denies every write this service makes, because default encryption applies server-side and the request never carries it
- [x] 9.3 Storage stack: lifecycle rules for staging expiry, incomplete-multipart abort, and originals storage-class transitions (both target classes are instant-retrieval; a class needing a restore step would turn a cache miss into a failed request. Derivatives are deliberately left in Standard)
- [x] 9.4 Data stack: RDS PostgreSQL in private subnets with credentials in the secret store — isolated subnets rather than merely private, since nothing in the deployment needs the database to reach the internet
- [x] 9.5 Network stack: VPC, subnets, security groups, and S3/SQS VPC endpoints to minimize NAT egress
- [x] 9.6 Queue stack: SQS optimize queue with redrive policy and dead-letter queue
- [x] 9.7 Compute stack: optimizer and generator Lambdas on arm64 with an SQS event source, a Function URL with IAM auth, and reserved concurrency on the generator
- [x] 9.8 Compute stack: ECS Fargate service, ALB, task definition, autoscaling, and a one-off migration task definition — built from `FargateService` + `ApplicationLoadBalancer` directly rather than the L3 pattern, which wires a security-group rule that creates a cross-stack cycle
- [x] 9.9 CDN stack: CloudFront distribution, OAC to the derivatives prefix, origin group with the generator as failover on 403 and 404, and origin shield
- [x] 9.10 CDN stack: attach the generated CloudFront Function on viewer-request, configure the cache policy to include no query strings, headers, or cookies
- [x] 9.11 CDN stack: ACM certificate, custom domain alias, DNS record, HTTP-to-HTTPS redirect, and error-response TTL configuration — the certificate is a us-east-1 stack of its own, and an externally managed DNS zone falls back to emitting the records rather than failing
- [x] 9.12 IAM: least-privilege roles — generator reads originals/masters and writes only derivatives; distribution reads only derivatives without list permission. `s3:ListBucket` is bucket-level and cannot be scoped by ARN, so every grant of it carries an `s3:prefix` condition, asserted in the tests
- [x] 9.13 Configure Lambda artifact builds in a container matching the target runtime so native binaries are correct (`scripts/build-sharp-layer.sh`, `--platform linux/arm64`; `lib/artifacts.ts` fails synth when an artifact is missing rather than packaging an empty directory)
- [x] 9.14 Add a post-deploy smoke test invoking the deployed generator against a known image (`scripts/smoke-test.ts`; reads stack outputs and makes plain HTTPS requests, so it runs from CI or a laptop with only credentials)
- [ ] 9.15 Deploy to a staging environment and verify the full path: upload, first request generates, second request is served from storage — **blocked: needs an AWS account.** No credentials, AWS CLI, or CDK CLI on the development machine. Everything above is verified only as far as synthesis
- [x] 9.16 Deliver database credentials from the secret store to both runtimes — added during implementation. ECS injects `DB_PASSWORD` from Secrets Manager at container start; Lambda has no equivalent and a function environment variable is plaintext in the console, so the functions receive the secret's ARN and resolve it during init (`packages/db/src/secrets.ts`). `packages/config` composes the connection URL from the parts either way

## 10. Client Package

- [x] 10.1 Implement the framework-agnostic typed URL builder with no React dependency (three entry points: `.`, `./react`, `./next`; only the middle one touches React, and it is an optional peer dependency)
- [x] 10.2 Implement `srcset` generation drawn from the shared ladder and capped at source width
- [x] 10.3 Implement a `sizes` helper and centralized client configuration for the CDN host and defaults — `encoderEpoch` is required rather than defaulted, since a wrong value silently produces URLs that resolve to nothing
- [x] 10.4 Implement the React image component emitting intrinsic width/height, lazy loading, and async decoding by default
- [x] 10.5 Implement priority mode: eager loading, high fetch priority, and a preload link with `imagesrcset` and `imagesizes` — React 19 emits its own preload for a high-priority image, so `<ImagePreload>` is only needed on React 18 or for an image this component does not render. Pinned by a test so the redundancy is not discovered by shipping the hint twice
- [x] 10.6 Implement LQIP blur-up rendering with no additional network request, and a dominant-color fallback — nothing clears the placeholder on load, because an `<img>` paints its content over its own background; clearing it would require state and turn a zero-JS component into a client one
- [x] 10.7 Implement the Next.js custom loader with device sizes aligned to the ladder
- [x] 10.8 Implement the picture-element helper for art-direction cases
- [x] 10.9 Implement upload helpers for both ingest modes with automatic mode selection by size and progress reporting (XHR for the presigned path, because `fetch` still cannot observe request-body progress)
- [x] 10.10 Write tests asserting every generated srcset candidate width is on the ladder and never exceeds source width (88 tests)
- [x] 10.11 Build a minimal Next.js example app exercising hero, gallery, and avatar cases (`examples/nextjs`, prerenders statically so the emitted markup is directly inspectable)
- [x] 10.12 Choose the candidate set from `sizes` rather than emitting the whole ladder — added during implementation. A full-bleed hero was emitting nineteen candidates starting at `16w`; the icon rungs can never be selected for a viewport-scaled image, and every candidate offered is a width some browser may request and the service will then generate and store forever. Viewport-scaled images now get device rungs, fixed-size images get the 1x and 2x rungs
- [x] 10.13 Scale a pinned height with each candidate width — added during implementation, found by inspecting the example's rendered markup. A `w=1200,h=800` crop was emitting `w=320&h=800` on every candidate, requesting a portrait 2.5 ratio where a 3:2 landscape was intended. It still fills its box, so nothing looks broken until the mobile breakpoint is noticed — and each wrong ratio is its own cache key and its own generation

## 11. Security Hardening

- [x] 11.1 Add WAF rate-based rules on the ALB for mutating endpoints (`infra/cdk/lib/waf.ts`; mutating paths get a tighter budget than reads, and the broad managed ruleset runs in COUNT mode because it flags ordinary multipart image uploads)
- [x] 11.2 Enable GuardDuty Malware Protection on the staging prefix and implement finding-driven quarantine (`infra/cdk/lib/malware-scanning.ts`; scoped to `staging/` only, tagging enabled because the tag _is_ the channel the control plane reads, and the quarantine handler can delete nothing outside staging)
- [x] 11.3 Implement the fail-closed policy when a malware verdict is unavailable — an unavailable verdict _holds_ the upload (202, asset stays `pending_upload`, bytes stay in staging) rather than rejecting it, because scanning is asynchronous and "not scanned yet" is indistinguishable from "scanner broken"
- [x] 11.4 Add `X-Content-Type-Options: nosniff` and the security header set to all delivery and API responses — registered on the Fastify adapter rather than as Nest middleware, so it also covers responses Nest never sees. HSTS only on HTTPS, so local development is not pinned in a developer's browser
- [x] 11.5 Implement API key issuance, hashed storage, one-time plaintext display, and revocation (`POST/GET/DELETE /v1/keys`, guarded by an `admin` permission; revocation is a soft delete so the quota accounting and upload history survive the incident that prompted it)
- [x] 11.6 Implement optional CloudFront signed-URL delivery for private assets on a separate cache behavior (`infra/cdk/lib/private-delivery.ts` + `SignedUrlService`; a separate behavior because trusted key groups apply per behavior, so enabling it on the default one would demand a signature for every public image)
- [x] 11.7 Audit logs for credential, signature, and presigned-URL leakage and add redaction — presigned `fields` were the notable gap: `Policy` plus `X-Amz-Signature` is a working upload credential and passes through the API as ordinary response data
- [x] 11.8 Write security tests: polyglot file, executable disguised as an image, decompression bomb, oversized presigned upload, direct bucket access, and CDN path traversal toward the originals prefix (19 integration tests)
- [x] 11.9 Separate "scanning is enabled" from "fail closed" — added during implementation. `failClosedOnScanUnavailable` defaults to true, so with no scanner provisioned every upload would have been held forever, presenting as a broken uploader rather than a missing configuration. The CDK stack sets the app flag from the same value that provisions the scanner, and a synth assertion pins them together

## 12. Observability

- [x] 12.1 Configure pino JSON logging with redaction across the API and both Lambdas — plus a request-completion record (route pattern, status, duration, asset id, correlation id) registered on the Fastify adapter rather than as a Nest interceptor, so it also covers requests Nest never routes
- [x] 12.2 Implement correlation-id propagation from API through SQS message attributes into the worker (landed with groups 6 and 7; an inbound `x-correlation-id` is adopted rather than replaced)
- [x] 12.3 Implement CloudWatch EMF metric emission for generation latency, count, and failures by format and bucket (`packages/metrics`; EMF rather than `PutMetricData` because the generator sits on the path a viewer is waiting on, and a metric call there is a network round trip added to the one request that is already slow)
- [x] 12.4 Implement the on-demand generation rate metric and its alarm — plus `RedundantGenerations`, counting generations whose conditional write found the object already present. A strictly stronger drift signal: once is two concurrent first requests racing, sustained has no innocent explanation
- [x] 12.5 Implement bytes-served-by-format and upload-rejection-by-reason metrics
- [x] 12.6 Enable X-Ray on the control path only, explicitly excluding the delivery path (API sidecar + optimizer `ACTIVE`; generator explicitly `DISABLED`, pinned by a synth assertion so a future default cannot switch it on)
- [x] 12.7 Define alarms: dead-letter depth above zero, queue age, generation failure rate, cache hit ratio, 5xx rate, unhealthy tasks (`infra/cdk/lib/observability-stack.ts`; failure is a _rate_, since a raw count alarms on a traffic spike and stays quiet at 3am when most requests fail)
- [x] 12.8 Build the CloudWatch dashboard covering delivery health, pipeline health, cost proxies, and volume — leads with a text widget naming the failure that looks healthy, because that is the one an operator will not think to check
- [ ] 12.9 Verify each alarm fires by inducing its condition in staging — **blocked: needs an AWS account**, as 9.15 is. Alarm definitions are verified only to synthesis
- [x] 12.10 Import metric names into the alarms from the emitting package rather than re-declaring them — added during implementation. An alarm watching a misspelled metric sits in INSUFFICIENT_DATA indefinitely, which on a dashboard is indistinguishable from healthy

## 13. Lifecycle and Cost Controls

- [x] 13.1 Implement the EventBridge-scheduled orphan reconciliation job with a safety window excluding recently written objects (`apps/maintenance`, daily). The window is load-bearing: the generator writes a derivative _before_ its bookkeeping row, and that row is best-effort — so a recent object with no row is the normal state during generation, not an orphan
- [x] 13.2 Implement superseded-version retention and expiry of old versions' derivatives after the grace period — objects are deleted before rows, since the reverse order leaves objects that look live for a full safety window
- [x] 13.3 Implement the pending-upload reaper for abandoned presigned uploads
- [x] 13.4 Implement per-asset and aggregate storage accounting split by originals, masters, and derivatives — split three ways because each is driven by a different decision (ingest volume, the master threshold, the warm set), and one total hides the effect of widening the warm set
- [x] 13.5 Implement the encoder epoch as configuration, verifying that a bump mints a new URL space with no per-asset writes — asserted directly: `toCanonicalKey` is a pure function of the epoch, so a bump moves every asset's URLs from one changed argument and touches no row
- [x] 13.6 Make the CloudFront price class configurable per deployment (staging and production deliberately differ, pinned by a synth assertion)
- [ ] 13.7 Run a load test measuring cache hit ratio, generation count per asset, and cost per thousand delivered images — **script written** (`infra/cdk/scripts/load-test.ts`) but **never run: needs a deployment**, as 9.15 and 12.9 do. It fails the run when generations exceed distinct variants, which is the bounded-variant-space claim stated as an assertion
- [x] 13.8 Give the maintenance worker a per-run deletion cap and a dry-run mode — added during implementation. Every deletion here is irreversible and the objects include originals, so the cap bounds a bug's blast radius to one run and the dry run makes a first execution safe to inspect
- [x] 13.9 Leave unparseable keys in place rather than deleting them — added during implementation. An unrecognized key almost certainly means this code is out of date, not that the object is junk; the count is reported so it is investigated instead of silently reclaimed

## 14. Documentation and Release

- [x] 14.1 Write the architecture overview with the Mermaid diagrams from `design.md` (`docs/architecture.md`)
- [x] 14.2 Write the API reference covering every control-plane endpoint and the transform parameter grammar (`docs/api-reference.md`)
- [x] 14.3 Write the integration guide for React, Next.js, and non-React consumers (`docs/integration.md`)
- [x] 14.4 Write the bootstrap guide: empty AWS account to working deployment with a custom domain (`docs/bootstrap.md`) — marked at the top as never executed, with the known rough edges listed rather than smoothed over
- [x] 14.5 Write the operations runbook: encoder epoch procedure, dead-letter replay, cache-miss investigation, and cost review (`docs/operations.md`) — leads with the regeneration failure, since it is the only one that produces no errors
- [x] 14.6 Document the tuning knobs — warm set, ladder, quality levels, thresholds — and their cost and latency trade-offs (`docs/tuning.md`), separating redeploy knobs from transform grammar, where a change is an encoder-epoch event
- [ ] 14.7 Run AWS Lambda Power Tuning against the generator and record the chosen memory setting with its measurements — **blocked: needs an AWS account.** The procedure and an empty results table are in `docs/tuning.md`; the current 3008MB is a starting guess and is labelled as one
- [ ] 14.8 Publish the client package and tag the first release of the deployable stack — **blocked, and deliberately not attempted.** This is not a git repository, no npm credentials are configured, and every package is `private: true`. Publishing is outward-facing and irreversible, and the `@imgopt` scope may not be the owner's; the decisions and the procedure are written up in `docs/release.md` instead
