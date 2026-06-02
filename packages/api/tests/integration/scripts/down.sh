#!/usr/bin/env bash
set -euo pipefail

# Tear down the worktree-isolated test stack.
#
# Passes BOTH compose files (+ --remove-orphans) so the optional prod-style api
# container (docker-compose.prod.yaml) and its named volume are reaped too —
# the old single-file down left synapse-int-api + api_storage_int as orphans.
#
# Uses lib.sh in `down` mode: it trusts the project name recorded in .stack-env
# and never re-floats on port drift, so we always tear down exactly what was
# brought up.
#
#   KEEP_VOLUMES=1     keep named volumes (omit -v)
#   KEEP_CONTAINERS=1  no-op (leave the whole stack up for debugging)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh" down

KEEP_VOLUMES="${KEEP_VOLUMES:-0}"
KEEP_CONTAINERS="${KEEP_CONTAINERS:-0}"

if [[ "${KEEP_CONTAINERS}" == "1" ]]; then
  echo "[down.sh] KEEP_CONTAINERS=1 — leaving stack '${INT_PROJECT_NAME}' up for debugging."
  exit 0
fi

COMPOSE_ARGS=(
  -p "${INT_PROJECT_NAME}"
  -f "$INTEGRATION_DIR/docker-compose.test.yaml"
  -f "$INTEGRATION_DIR/docker-compose.prod.yaml"
)

echo "[down.sh] Stopping test stack (project: ${INT_PROJECT_NAME})..."
if [[ "${KEEP_VOLUMES}" == "1" ]]; then
  docker compose "${COMPOSE_ARGS[@]}" down --remove-orphans
else
  docker compose "${COMPOSE_ARGS[@]}" down -v --remove-orphans
fi

# Clear the recorded stack so the next `up` re-derives cleanly.
rm -f "$INTEGRATION_DIR/.stack-env"

# Remove the per-worktree storage dir created by run-test.sh (keyed on the full
# project name). Owned here so BOTH the owning wrapper and manual
# up.sh + run-test.sh + down.sh flows clean it up.
rm -rf "/tmp/${INT_PROJECT_NAME}-storage" 2>/dev/null || true

echo "[down.sh] Done."
