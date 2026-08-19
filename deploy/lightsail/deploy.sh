#!/usr/bin/env bash
#
# Deploy or roll back the control plane.
#
#   ./deploy.sh v1.4.0     deploy that tag
#   ./deploy.sh v1.3.0     roll back to that tag — the same command, which is the point
#
# The tag must be immutable. It is the rollback coordinate, and a mutable one makes
# "redeploy the previous version" ambiguous: the same tag can point at different bytes
# on two consecutive days.
#
# Fails *forward-safely*: if the new version does not answer its health check, the
# previous tag is restored before this script exits non-zero. A failed deploy that
# leaves a broken container running is worse than one that never started.

set -euo pipefail

APP_DIR=${APP_DIR:-/opt/imgopt}
cd "$APP_DIR"

TAG=${1:-}
if [[ -z "$TAG" ]]; then
  echo "usage: deploy.sh <image-tag>" >&2
  exit 1
fi
if [[ "$TAG" == "latest" ]]; then
  echo "Refusing 'latest'. The tag is the rollback coordinate; it must be immutable." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

PREVIOUS=${IMAGE_TAG:-}
export IMAGE_TAG="$TAG"

echo "==> Pulling ${IMAGE_REPO}:${TAG}"
aws ecr get-login-password --region "${AWS_REGION}" \
  | docker login --username AWS --password-stdin "${IMAGE_REPO%%/*}"
docker compose pull migrate api

echo "==> Migrating"
# Before the new code takes traffic, and as a one-off — never on container start.
# A failure here stops the deploy with the old version still serving, which is the
# correct outcome: an unmigrated schema and new code is the combination to avoid.
docker compose run --rm migrate

echo "==> Starting ${TAG}"
docker compose up -d --remove-orphans

echo "==> Waiting for health"
healthy=false
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 http://127.0.0.1:3000/healthz >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 2
done

if [[ "$healthy" != true ]]; then
  echo "!! ${TAG} did not become healthy." >&2
  if [[ -n "$PREVIOUS" && "$PREVIOUS" != "$TAG" ]]; then
    echo "!! Rolling back to ${PREVIOUS}." >&2
    # Deliberately *not* re-running migrations. They are forward-only, and the old
    # image running against a newer schema is the situation Prisma migrations are
    # designed to tolerate — re-running them backwards is not a thing that exists.
    IMAGE_TAG="$PREVIOUS" docker compose up -d
  else
    echo "!! No previous tag recorded; leaving the stack as it is for inspection." >&2
  fi
  exit 1
fi

# Readiness is checked but not fatal: it depends on Postgres and S3, and a dependency
# blip during a deploy should be reported rather than trigger a rollback of code that
# is fine.
if ! curl -fsS --max-time 5 http://127.0.0.1:3000/readyz >/dev/null 2>&1; then
  echo "   warning: /readyz is not passing — check the database and bucket." >&2
fi

# Recorded last, so the value in .env is always a tag that actually became healthy.
# That is what makes it a trustworthy rollback target next time.
if grep -q '^IMAGE_TAG=' .env; then
  sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=${TAG}|" .env
else
  echo "IMAGE_TAG=${TAG}" >> .env
fi

docker image prune -f >/dev/null 2>&1 || true
echo "==> ${TAG} is live"
