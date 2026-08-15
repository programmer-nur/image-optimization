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
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---- Build: generate the Prisma client, compile TypeScript ----
FROM deps AS build
COPY packages packages
COPY apps/api apps/api
# `prisma generate` never connects to anything, but Prisma 7 resolves the datasource
# URL when it *loads* prisma.config.ts, so an absent DATABASE_URL fails the build
# with an error that reads like a connection problem. A placeholder satisfies the
# config loader and goes no further than this layer.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build \
    pnpm --filter @imgopt/db db:generate
RUN pnpm --filter @imgopt/api... build

# ---- Production dependencies only ----
FROM deps AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ---- Runtime ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /repo

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
# Production node_modules, so dev-only deps (sharp-for-tests, swc) are excluded.
COPY --from=prod-deps --chown=node:node /repo/apps/api/node_modules ./apps/api/node_modules

ENV PORT=3000
EXPOSE 3000

# The ALB/ECS health check also probes /readyz; this in-container check is a coarse
# liveness signal against the process itself.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/main.js"]
