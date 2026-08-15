# Release

> **Nothing here has been executed.** This repository is not a git repository, no npm
> credentials are configured, and every package is marked `private: true`. Publishing
> is outward-facing and effectively irreversible — a version number on a public
> registry cannot be reused even after unpublishing — so the steps below are written
> down rather than run.

## Before anything

Decisions that have to be made by someone who owns the accounts, not inferred:

- **Is `@imgopt` the right scope, and do you own it on npm?** The name is a
  placeholder chosen for the workspace. Publishing under a scope you do not control
  fails; publishing under one you do control is permanent.
- **Public or private registry?** A private registry (npm paid, GitHub Packages,
  CodeArtifact) is the usual answer for a service deployed one copy per project. Only
  `@imgopt/client` is meant for consumers at all.
- **Which packages ship?** `@imgopt/client` is the only one with an external
  audience. `core`, `config`, `storage`, `queue`, `db`, and `metrics` are internal
  seams; publishing them commits you to their APIs.

## What ships, and what does not

| Package          | Audience               | Publish?                             |
| ---------------- | ---------------------- | ------------------------------------ |
| `@imgopt/client` | consuming applications | yes                                  |
| `@imgopt/core`   | internal               | only if `client` needs it at runtime |
| everything else  | internal               | no                                   |

`@imgopt/client` depends on `@imgopt/core` at runtime (the ladder, the canonical key,
the transform types). Two options, and the first is simpler:

1. **Bundle core into client** at build time, so consumers install one package.
2. **Publish both**, and accept that their versions must move together — a client
   built against one ladder and a core carrying another is the drift failure this
   whole system is built to prevent, relocated into a consumer's `node_modules`.

If you publish both, pin the dependency exactly (`"@imgopt/core": "1.2.3"`, not
`^1.2.3`).

## Steps

```bash
# 1. Everything green, from a clean install.
pnpm install --frozen-lockfile
pnpm --filter @imgopt/db db:generate
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test

# 2. The generated edge function is current. CI checks this, but only after a push.
pnpm --filter @imgopt/edge generate
git diff --exit-code -- infra/cloudfront/normalize.generated.js

# 3. Integration suite against the local stack.
pnpm dev:up
DATABASE_URL='postgres://imgopt:imgopt@localhost:5434/imgopt' \
  pnpm --filter @imgopt/db db:migrate
pnpm test:integration

# 4. Drop `private`, set a version, and publish.
#    --dry-run first, always: it prints exactly what would be uploaded.
pnpm --filter @imgopt/client publish --dry-run --access public

# 5. Tag.
git tag -a v0.1.0 -m "First release"
git push origin v0.1.0
```

## Versioning

The client package and the deployable stack are versioned **together**, because they
are not independent: the client builds URLs that only a matching deployment can serve.

The version numbers that actually matter are not semver:

- **`encoderEpoch`** is the compatibility boundary for delivery URLs. A client
  configured with the wrong epoch produces URLs that resolve to nothing.
- **`assetVersion`** is per-asset and moves when source bytes are replaced.

A client release that changes the ladder, the canonical key, or the quality levels is
**not** a minor version. It is a breaking change that requires an epoch bump and a
coordinated deployment, because it changes what every existing URL means. See the
[epoch procedure](operations.md#changing-encoder-policy-the-epoch-procedure).

## Deployment artifacts

The deployable stack is not an npm package. A "release" of it is:

- a container image tag in ECR (`API_IMAGE_TAG`),
- the Lambda bundles and the sharp layer, built per
  [the bootstrap guide](bootstrap.md#3-build-the-artifacts),
- the committed `infra/cloudfront/normalize.generated.js`.

The git tag should name the commit all three were built from, so a rollback is a
redeploy of a known tag rather than an archaeology exercise.

## Before the first production deployment

Four tasks in `tasks.md` remain blocked on having an AWS account, and each is a
genuine gap rather than a formality:

- **9.15** — deploy to staging and verify upload → generate → cache. The sharp layer's
  architecture and the Lambda secret-resolution path have never run.
- **12.9** — induce each alarm condition and confirm it fires. An alarm that never
  fired is an untested alarm.
- **13.7** — run the load test and record cache hit ratio, generations per asset, and
  cost per thousand images.
- **14.7** — power-tune the generator. Its 3008MB is a guess.

Do all four against staging before production carries traffic.
