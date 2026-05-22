#!/usr/bin/env bash
# Run Playwright tests against THIS worktree's staging stack, using the
# official Playwright Docker image (so the host OS doesn't need browsers).
#
# Usage:
#   source infrastructure/scripts/staging-env.sh
#   ./infrastructure/scripts/run-e2e.sh [-- <extra playwright args>]
#
# The staging stack must already be up (use redeploy-staging.sh first).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if [[ -z "${SYNAPSE_STAGING_SLUG:-}" || -z "${NGINX_PORT:-}" ]]; then
  echo "Please \`source infrastructure/scripts/staging-env.sh\` first." >&2
  exit 1
fi

# The Playwright image version should track @playwright/test in
# packages/e2e/package.json. Update both when bumping Playwright.
IMAGE="mcr.microsoft.com/playwright:v1.60.0-noble"

# The runner attaches to the same docker network as our staging stack so it
# can reach nginx-http via the compose internal DNS name. Falls back to the
# host gateway if the network alias isn't routable.
NETWORK="synapse-stg-${SYNAPSE_STAGING_SLUG}_default"
NGINX_CONTAINER="synapse-nginx-http-stg-${SYNAPSE_STAGING_SLUG}"

# Inside the network the nginx-http service is named `nginx-http` and listens
# on :80. That's the address Playwright should hit.
E2E_HOST="${NGINX_CONTAINER}"
E2E_PORT=80

exec docker run --rm \
  --network "${NETWORK}" \
  -v "${REPO_ROOT}:/work" \
  -w /work/packages/e2e \
  -e SYNAPSE_STAGING_HOST="${E2E_HOST}" \
  -e NGINX_PORT="${E2E_PORT}" \
  -e CI="${CI:-}" \
  --ipc host \
  --user "$(id -u):$(id -g)" \
  "${IMAGE}" \
  npx playwright test "$@"
