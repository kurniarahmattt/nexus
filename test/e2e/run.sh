#!/usr/bin/env bash
# Run the full Nexus e2e test inside an isolated Docker-in-Docker
# container. The container clones the working tree (mounted read-only),
# runs the wizard unattended, and asserts every milestone.
#
# Usage:
#   test/e2e/run.sh                  # use current branch's checkout
#   test/e2e/run.sh --rebuild        # force rebuild of the test image
#
# Requirements on the host:
#   • Docker 24+ with the ability to run --privileged containers
#   • The repo checked out (this script must be run from inside it)

set -euo pipefail

REBUILD=0
case "${1:-}" in
  --rebuild) REBUILD=1 ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

IMG="nexus-e2e:latest"

if [ "$REBUILD" = "1" ] || ! docker image inspect "$IMG" >/dev/null 2>&1; then
  echo "[e2e] building $IMG"
  docker build -t "$IMG" -f test/e2e/Dockerfile .
fi

echo "[e2e] running container"
exec docker run --rm -t \
  --privileged \
  -v "$REPO_ROOT:/src:ro" \
  -v "$(pwd)/test/e2e/run-inside.sh:/e2e/run-inside.sh:ro" \
  --tmpfs /var/lib/docker \
  "$IMG"
