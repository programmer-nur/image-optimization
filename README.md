# image-optimization

Self-hosted image optimization service. NestJS control plane, S3 + CloudFront delivery, Sharp in Lambda. Deployed one copy per consuming project.

Accepts uploads, stores originals untouched, generates optimized derivatives, and serves them from a custom CDN domain with URL-based transforms:

```
https://cdn.example.com/i/{assetId}/{version}/hero?w=640&q=80&format=auto
```

## Status

Feature-complete against the build plan, and **never deployed**. Every task in
`openspec/changes/image-optimization-service/tasks.md` is done except four that need an
AWS account: staging deployment (9.15), alarm verification (12.9), the load test
(13.7), and Lambda power tuning (14.7). Treat any claim about runtime AWS behaviour as
reasoned rather than observed.

## Local development

```bash
pnpm install
cp .env.example .env
pnpm dev:up                              # postgres + minio + elasticmq
pnpm --filter @imgopt/db db:generate     # generated Prisma client is not committed
pnpm --filter @imgopt/db db:migrate      # apply migrations
pnpm test                                # unit; no Docker needed
pnpm test:integration                    # needs the stack above
```

Local ports are deliberately non-default — MinIO `9100`/`9101`, Postgres `5434` — because `9000` and `5432` are often already taken by another project, and colliding would point tests at someone else's data store.

| Command                                               |                                         |
| ----------------------------------------------------- | --------------------------------------- |
| `pnpm typecheck`                                      | Build all TypeScript project references |
| `pnpm lint` / `pnpm lint:fix`                         | ESLint across the workspace             |
| `pnpm format` / `pnpm format:check`                   | Prettier                                |
| `pnpm test`                                           | Unit tests, no services required        |
| `pnpm test:integration`                               | Integration tests, needs `pnpm dev:up`  |
| `pnpm test:core`                                      | `@imgopt/core` only                     |
| `pnpm --filter @imgopt/core test -- <pattern>`        | A single test file or name pattern      |
| `pnpm --filter @imgopt/core test:watch`               | Watch mode                              |
| `pnpm --filter @imgopt/core test:coverage`            | Coverage against thresholds             |
| `pnpm dev:up` / `dev:down` / `dev:reset` / `dev:logs` | Local service stack                     |

Local endpoints: Postgres `:5434`, MinIO `:9100` (console `:9101`, `minioadmin`/`minioadmin`), ElasticMQ `:9324`.

The first two are deliberately off their defaults: 5432 and 9000 are usually already taken on a dev machine, and a collision would quietly point the test suite at another project's database.

## Layout

```
packages/core      transform grammar, breakpoints, canonical keys, Sharp pipeline — no AWS imports
packages/config    zod-validated deployment config, shared by the API and both Lambdas
packages/storage   StoragePort + S3 adapter (MinIO locally via endpoint override)
packages/queue     QueuePort + SQS adapter (ElasticMQ locally)
packages/db        Prisma schema, migrations, asset registry
packages/metrics   CloudWatch EMF emission, shared by the API and both Lambdas
apps/api           NestJS control plane                      (task group 6)
apps/optimizer     SQS-triggered Lambda: warm set, metadata  (task group 7)
apps/generator     Function URL Lambda: on-miss generation   (task group 8)
apps/maintenance   scheduled reclamation and storage accounting (task group 13)
infra/cloudfront   edge normalizer, generated from packages/core, plus its conformance runner
infra/cdk          CDK stacks, split by lifecycle             (task group 9)
packages/client    URL builder, srcset, React + Next.js loader, upload helpers
examples/nextjs    minimal app exercising hero, gallery, and avatar cases
infra/local        local service configuration
```

`infra/cloudfront/normalize.generated.js` is a build artifact. Edit `normalize.template.js` and run `pnpm --filter @imgopt/edge generate`.

## How it works

Two planes that never touch:

- **Control plane** — NestJS on Fargate. Uploads, validation, metadata, lifecycle. Never in the image read path.
- **Delivery plane** — a CloudFront Function normalizes and rewrites the request URI, S3 serves the derivative if it exists, and on a miss CloudFront fails over to a Sharp Lambda that generates it, writes it to that exact key, and returns it. Every later request is a cache or S3 hit.

Requested widths snap to a fixed ladder, so `?w=602` and `?w=640` resolve to one cache key and one S3 object. That bound on the variant space is what keeps storage, cache hit ratio, and Lambda spend predictable — compute tracks new assets, not traffic.

## Documentation

| Guide                                  |                                                           |
| -------------------------------------- | --------------------------------------------------------- |
| [Architecture](docs/architecture.md)   | How the two planes fit together, and why                  |
| [API reference](docs/api-reference.md) | Control-plane endpoints and the transform grammar         |
| [Integration](docs/integration.md)     | React, Next.js, and non-React consumers                   |
| [Bootstrap](docs/bootstrap.md)         | Empty AWS account to a working deployment                 |
| [Operations](docs/operations.md)       | Epoch procedure, dead letters, cache misses, cost review  |
| [Tuning](docs/tuning.md)               | Every knob, what it buys, and what it costs               |
| [Release](docs/release.md)             | Versioning, what ships, and what is still blocked         |
| [Infrastructure](infra/cdk/README.md)  | Stack layout, release order, and the parts that will bite |

Decisions and their alternatives: [`design.md`](openspec/changes/image-optimization-service/design.md).
Invariants that are easy to break: [`CLAUDE.md`](CLAUDE.md).

## Deploying

Everything under `infra/cdk` is written and synthesizes, but **has never been deployed**. Start with [the bootstrap guide](docs/bootstrap.md).
