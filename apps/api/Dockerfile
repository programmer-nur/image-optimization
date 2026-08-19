# Multi-stage build for the control-plane container.
#
# The workspace is a pnpm monorepo, so the build installs from the root, generates
# the Prisma client, compiles every referenced package, then ships a pruned
# production install. Runs as a non-root user with a healthcheck against /healthz.

# ---- Base: pnpm on Node 22 (Debian slim; sharp and Prisma both ship glibc binaries) ----
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# `CI=true` is not cosmetic here. The prod-deps stage re-installs over a node_modules
# that already holds dev dependencies, and pnpm refuses to purge a modules directory
# without a TTY to confirm at — which fails the build with an error about terminals
# rather than about packages.
ENV CI=true
RUN corepack enable
WORKDIR /repo

# ---- Dependencies: install the whole workspace with the lockfile ----
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY tsconfig.base.json tsconfig.json ./
# Every workspace package the API depends on, transitively. A missing one does NOT
# fail the install — pnpm simply treats the workspace as smaller — so the error
# surfaces later as an unresolved import during compilation, pointing at the wrong
# thing. Keep this list in step with apps/api/package.json.
COPY packages/config/package.json packages/config/
COPY packages/core/package.json packages/core/
COPY packages/storage/package.json packages/storage/
COPY packages/queue/package.json packages/queue/
COPY packages/db/package.json packages/db/
COPY packages/metrics/package.json packages/metrics/
COPY apps/api/package.json apps/api/
# Reclamation ships in this image too — it runs on the control-plane host, beside the
# database, rather than in Lambda.
COPY apps/maintenance/package.json apps/maintenance/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---- Build: generate the Prisma client, compile TypeScript ----
FROM deps AS build
COPY packages packages
COPY apps/api apps/api
COPY apps/maintenance apps/maintenance
# `prisma generate` never connects to anything, but Prisma 7 resolves the datasource
# URL when it *loads* prisma.config.ts, so an absent DATABASE_URL fails the build
# with an error that reads like a connection problem. A placeholder satisfies the
# config loader and goes no further than this layer.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build \
    pnpm --filter @imgopt/db db:generate
RUN pnpm --filter @imgopt/api... build
# Bundled last, so it compiles against the packages just built.
RUN pnpm --filter @imgopt/maintenance build && pnpm --filter @imgopt/maintenance bundle

# ---- Production dependencies only ----
FROM deps AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ---- Runtime ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /repo

# Prisma's migration engine looks for libssl and, not finding it on this base image,
# warns and guesses `openssl-1.1.x`. The guess currently works, which is the problem:
# it is one base-image bump away from failing, and it would fail at the deploy's
# migration step. Installing it costs a few megabytes and removes the guess.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

# Reclamation's run-lock directory, created here and owned by `node`.
#
# A Docker named volume inherits the ownership of the image's directory at its mount
# point on first use — so without this the volume arrives root-owned, the container
# (which runs unprivileged) cannot write the lock, and `acquireLock` reports that as
# "a run is already in progress". Reclamation then never runs, silently, forever.
RUN install -d -o node -g node /var/lib/imgopt

# Drop privileges. node:22-slim ships a `node` user.
USER node

COPY --from=prod-deps --chown=node:node /repo/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /repo/packages ./packages
COPY --from=build --chown=node:node /repo/packages/config/dist ./packages/config/dist
COPY --from=build --chown=node:node /repo/packages/core/dist ./packages/core/dist
COPY --from=build --chown=node:node /repo/packages/storage/dist ./packages/storage/dist
COPY --from=build --chown=node:node /repo/packages/queue/dist ./packages/queue/dist
COPY --from=build --chown=node:node /repo/packages/db/dist ./packages/db/dist
COPY --from=build --chown=node:node /repo/packages/metrics/dist ./packages/metrics/dist
COPY --from=build --chown=node:node /repo/packages/db/src/generated ./packages/db/src/generated
COPY --from=build --chown=node:node /repo/apps/api/dist ./apps/api/dist

# The migration step's payload, not the API's.
#
# This same image runs `packages/db/scripts/migrate.mjs` as a one-off container before
# the new version takes traffic, and `migrate deploy` needs the schema, the migration
# SQL, and the CLI config — none of which a compiled `dist` contains. An image without
# them builds perfectly and then fails at the one step standing between a green deploy
# and a working database.
COPY --from=build --chown=node:node /repo/packages/db/prisma ./packages/db/prisma
COPY --from=build --chown=node:node /repo/packages/db/prisma.config.ts ./packages/db/prisma.config.ts
COPY --from=build --chown=node:node /repo/packages/db/scripts ./packages/db/scripts
# Reclamation, as a single bundled file.
#
# It runs here rather than in Lambda because it holds the only remaining direct
# database connection and the database is reachable only from this host (design.md
# L2). Bundled rather than assembled from workspace packages precisely so it adds
# nothing to the hand-maintained COPY list above — the failure mode that list has is a
# missing package that surfaces as an unresolved import at runtime, and a bundle
# cannot have one.
COPY --from=build --chown=node:node /repo/apps/maintenance/dist-bundle/maintenance.mjs ./maintenance.mjs

# Production node_modules, so dev-only deps (sharp-for-tests, swc) are excluded.
COPY --from=prod-deps --chown=node:node /repo/apps/api/node_modules ./apps/api/node_modules

ENV PORT=3000
EXPOSE 3000

# Compose probes this too. `/healthz` and not `/readyz`: liveness must not depend on
# Postgres, or a database blip restarts a healthy process — which is the one action
# that cannot help.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/main.js"]
