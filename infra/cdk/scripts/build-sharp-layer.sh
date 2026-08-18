#!/usr/bin/env bash
#
# Builds the sharp Lambda layer inside a container matching the target runtime.
#
# WHY A CONTAINER. sharp ships prebuilt libvips binaries per platform, and npm
# resolves them for the *host* doing the install. A layer built on a macOS or x86
# workstation deploys perfectly and then throws
#
#   Could not load the "sharp" module using the linux-arm64 runtime
#
# on its first real invocation — that is, in front of a viewer, after CI was green.
# Building in the runtime's own image makes the artifact independent of whoever ran
# the release. See the deployment-packaging spec, "Lambda artifacts are built for
# their target runtime".
#
# Emits infra/cdk/layers/sharp/nodejs/node_modules/sharp, the path Lambda expects.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAYER_DIR="${HERE}/../layers/sharp"
NODEJS_DIR="${LAYER_DIR}/nodejs"

# Pinned so a rebuild produces the same binaries. Bumping this is an encoder-epoch
# level decision: a libvips upgrade can change encoder output, and every derivative
# already cached at the edge was produced by the previous one. See design.md D8.
SHARP_VERSION="0.35.3"
BUILD_IMAGE="public.ecr.aws/sam/build-nodejs22.x:latest-arm64"

# An *array*, so a multi-word override works. `DOCKER="docker --context default"`
# expanded inside quotes is one filename with spaces in it, which fails with the same
# "cannot reach the Docker daemon" message it is meant to cure — the escape hatch this
# script documents did not work until it was one.
read -r -a DOCKER_CMD <<< "${DOCKER:-docker}"

if ! "${DOCKER_CMD[@]}" info >/dev/null 2>&1; then
  echo "error: cannot reach the Docker daemon." >&2
  echo "  If a stale context is selected, try: DOCKER='docker --context default' $0" >&2
  exit 1
fi

rm -rf "${LAYER_DIR}"
mkdir -p "${NODEJS_DIR}"

echo "Building sharp ${SHARP_VERSION} for linux/arm64 in ${BUILD_IMAGE}..."

# --platform matters even with an arm64-tagged image: on an x86 host without it,
# Docker will happily run the amd64 variant and produce the wrong binaries.
"${DOCKER_CMD[@]}" run --rm --platform linux/arm64 \
  -v "${NODEJS_DIR}:/out" \
  -w /build \
  "${BUILD_IMAGE}" \
  bash -c "
    set -euo pipefail
    npm init -y >/dev/null
    npm install --no-audit --no-fund \
      --os=linux --cpu=arm64 --libc=glibc \
      sharp@${SHARP_VERSION}
    cp -r node_modules /out/
  "

if [ ! -d "${NODEJS_DIR}/node_modules/sharp" ]; then
  echo "error: sharp is missing from the built layer." >&2
  exit 1
fi

echo "Layer built: ${LAYER_DIR}"
du -sh "${LAYER_DIR}"
