#!/usr/bin/env bash
set -euo pipefail

# Bring up the worktree-isolated test stack.
# Idempotent: skips if containers already healthy.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTEGRATION_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_NAME="synapse-int-test"
COMPOSE_FILE="$INTEGRATION_DIR/docker-compose.test.yaml"

# Conflict detection — fail loud if our chosen ports are occupied by something else.
for port in 55433 56380; do
  if ss -tln 2>/dev/null | grep -q ":${port}\b"; then
    # Allow if it's our own container
    own_container=$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null \
      | grep ":${port}->" \
      | awk '{print $1}' || true)
    if [[ -z "$own_container" || "$own_container" != synapse-int-* ]]; then
      echo "[up.sh] Port ${port} is in use by something that's not a synapse-int-* container."
      echo "[up.sh] Run 'ss -tlnp | grep ${port}' or 'docker ps' to find the owner."
      exit 1
    fi
  fi
done

echo "[up.sh] Bringing up test postgres + redis (project: ${PROJECT_NAME})..."
docker compose -p "${PROJECT_NAME}" -f "${COMPOSE_FILE}" up -d --wait

echo "[up.sh] Stack ready:"
docker compose -p "${PROJECT_NAME}" -f "${COMPOSE_FILE}" ps
