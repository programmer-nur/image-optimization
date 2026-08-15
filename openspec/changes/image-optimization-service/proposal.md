## Why

Every project ends up rebuilding the same image pipeline badly: uploads that fail on large files, originals mutated in place, a `resize()` call bolted onto a controller, no CDN story, and an S3 bucket that grows without bound because every requested width produces a new object. Commercial platforms (Cloudinary, Imgix, ImageKit, Vercel Image Optimization) solve this well but bind you to per-image pricing, an external vendor, and a URL scheme you do not control.

This change builds that pipeline **once**, as a self-hostable infrastructure product on AWS, so it can be deployed as a standalone service alongside any future application. The design target is millions of images with predictable, low AWS cost — achieved primarily by refusing to generate arbitrary image sizes and by serving almost every request from CloudFront rather than from compute.

## What Changes

- **New standalone NestJS service** (TypeScript, ECS Fargate) acting as the control plane: uploads, validation, asset metadata, lifecycle operations, and admin endpoints. This repo currently contains only OpenSpec scaffolding — everything is greenfield.
- **Upload path that cannot fail on size.** Two ingest modes: a proxied multipart `POST /v1/images` for small files, and a presigned direct-to-S3 flow for large ones (50MB–100MB+). Validation happens on bytes actually received (magic-number signature check, dimension/pixel-count limits, decompression-bomb defense), never on client-declared MIME type. The original is written once to `original/` and is **never** read-modify-written afterward.
- **Asynchronous derivative generation.** Upload returns as soon as the original is durably stored and an asset record exists. Optimization is queued (SQS → Sharp Lambda) and never blocks the client.
- **Hybrid generation strategy.** A small eager "warm set" of derivatives is generated at upload so the common render path is never cold; every other legal variant is generated lazily on first request and then persisted to S3, so it is generated at most once for the lifetime of the asset.
- **URL-based transform API** served from a custom CDN domain: `https://cdn.example.com/i/{assetId}/{version}/…?w=&h=&q=&fit=&format=&crop=&background=&blur=&sharpen=`. Parameters are validated, normalized, and canonicalized before they ever reach the cache key.
- **Breakpoint bucketing** as a first-class, enforced rule. Requested widths snap up to a fixed ladder (320…3840), quality snaps to a small set of levels, and every other parameter is quantized. A request for `w=602` and a request for `w=640` resolve to the identical cache key and the identical S3 object. Unbucketed sizes are not representable in the system.
- **CloudFront delivery with a normalizing CloudFront Function**, S3 as origin via OAC, and a Sharp Lambda reached only on origin 404 (the "generate-on-miss" fallback). Buckets stay private; CloudFront is the only public surface.
- **Immutable, version-addressed URLs** with `Cache-Control: public, max-age=31536000, immutable` and ETags. Mutating an asset mints a new version segment rather than invalidating the CDN.
- **Automatic format negotiation** — AVIF → WebP → JPEG/PNG chosen from the `Accept` header, with a normalized cache-key dimension so the CDN stores at most three format branches per variant.
- **PostgreSQL** for asset metadata, versions, and derivative bookkeeping. **Redis is deliberately not adopted** in the initial architecture; SQS provides queueing and CloudFront provides caching, so Redis would add an operational component without a job it uniquely does. This decision is revisited in `design.md`.
- **AWS CDK (TypeScript)** stacks defining S3, CloudFront + custom domain/ACM, SQS + DLQ, Lambda, RDS, ECS Fargate, IAM, EventBridge, and CloudWatch — deployed as one copy per consuming project, parameterized by config rather than forked.
- **A published client integration surface**: a framework-agnostic URL builder, `srcset`/`sizes` generation matching the breakpoint ladder, a Next.js custom image loader, and a React `<Image>` wrapper with AVIF/WebP `<picture>` fallback, lazy loading, `fetchpriority`, and preload support.
- **Observability from day one**: structured logs with a request/asset correlation id, CloudWatch EMF custom metrics (miss rate, generation latency, bytes served, failure counts), a DLQ for permanently failed jobs, alarms, and a dashboard.

## Capabilities

### New Capabilities

- `image-upload`: Ingest of original images — proxied and presigned-direct modes, size/type/dimension limits, magic-number and structural validation, malicious-file rejection, idempotent re-upload, and durable unmodified storage of the original.
- `image-asset-registry`: The asset as a domain object — identifiers, version numbers, source metadata (dimensions, format, colorspace, orientation, bytes), processing status lifecycle, derivative bookkeeping, soft delete, replace, and metadata update.
- `image-transformation`: The Sharp processing contract — resize, crop, fit modes, format conversion and encoder settings, quality/compression, metadata stripping, EXIF orientation correction, color/ICC handling, blur, sharpen, and background fill.
- `transform-api`: The public URL transform contract — parameter grammar, types, ranges, defaults, precedence, rejection behavior for invalid input, canonical ordering, and the extension rules for adding future parameters without breaking cached URLs.
- `responsive-breakpoints`: Bucketing — the width/height ladder, snap-up mapping, DPR handling, quality and effect quantization, aspect-ratio derivation, and the guarantee that distinct requests collapse onto a bounded set of cache keys and S3 objects.
- `derivative-pipeline`: Generation and persistence of derivatives — the eager warm set, lazy generate-on-miss, queue semantics, concurrency and duplicate-work suppression, retry/backoff, DLQ handling, and regeneration triggers.
- `cdn-delivery`: Edge behavior — cache key composition, CloudFront Function normalization, origin failover to the generator, `Accept`-based format negotiation, `Cache-Control`/`ETag`/`Vary` headers, immutability, versioned invalidation, and error/placeholder responses.
- `platform-security`: Authentication for write operations, per-key rate limiting and quotas, private buckets with OAC, optional signed transform URLs to prevent variant-flooding abuse, upload throttling, and the public/private boundary.
- `storage-lifecycle`: Prefix layout (`original/`, `derived/`), storage-class transitions, retention of derivatives vs. originals, orphan/garbage collection, cost controls, and deletion propagation across S3, the database, and the CDN.
- `observability`: Structured logging, correlation ids, custom metrics, tracing across API → SQS → Lambda → S3 → CDN, failure classification, queue depth monitoring, alarms, and the operational dashboard.
- `client-integration`: The consumer-facing surface — URL builder, `srcset`/`sizes` generation, Next.js loader, React component with `<picture>` fallback, lazy/priority loading, LQIP/blur placeholder, and server-side upload helpers.
- `deployment-packaging`: What it takes to stand up a copy for a new project — CDK stack composition, required configuration and secrets, custom domain/ACM setup, environment separation, database migration execution, and a documented bootstrap path.

### Modified Capabilities

None — `openspec/specs/` is empty; this is the first change in the project.

## Impact

- **Repository**: Introduces the entire codebase. NestJS application (`src/`), Lambda handlers (`lambda/`), CDK infrastructure (`infra/`), client package (`packages/client/`), database migrations, and Docker build.
- **Runtime dependencies**: `@nestjs/*`, `sharp` (with platform-correct binaries for both the container and the Lambda ARM64 runtime), `@aws-sdk/client-s3` + `client-sqs` + `s3-request-presigner`, `file-type` for signature detection, Prisma ORM with Prisma Migrate and the `@prisma/adapter-pg` driver adapter, `zod` for parameter validation, `pino` for logging, and `aws-cdk-lib`.
- **AWS resources created per deployment**: 1 S3 bucket (prefix-partitioned), 1 CloudFront distribution + CloudFront Function + ACM certificate + Route 53 record, 1 SQS queue + DLQ, 2 Lambda functions (async optimizer, on-miss generator), 1 RDS Postgres instance, 1 ECS Fargate service + ALB, IAM roles, CloudWatch log groups/metrics/alarms/dashboard, and EventBridge rules for scheduled maintenance jobs.
- **Cost profile**: Steady-state cost is dominated by ECS Fargate baseline, RDS, and CloudFront egress — not by Lambda, because bucketing plus derivative persistence makes image generation a one-time cost per variant rather than a per-request cost.
- **Public contract**: The transform URL grammar and the breakpoint ladder become long-lived public API. Once assets are cached at the edge and referenced from consumer applications, changing the ladder or the canonicalization rules is a cache-invalidating breaking change. `design.md` defines the versioning escape hatch for this.
- **Explicitly out of scope for this change**: video/animated-GIF transcoding, AI/ML transformations (background removal, upscaling, auto-tagging), a management UI/dashboard, multi-tenancy (one deployment serves one project), and non-AWS storage backends. The storage and CDN layers are defined behind interfaces so these remain addable later.
