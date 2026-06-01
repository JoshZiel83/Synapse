#!/usr/bin/env bash
set -euo pipefail

# Bring up the worktree-isolated test stack (postgres + redis).
# Idempotent: re-running reuses the same per-worktree project + ports.
#
# Project name and host ports are derived per-worktree by lib.sh, so multiple
# worktrees can run their own stacks concurrently without colliding. lib.sh
# handles conflict detection (floats to the next free port band only when the
# preferred ports are taken by a foreign listener) and records the choice in
# .stack-env so down.sh / run-test.sh reuse the exact same stack.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh" up
COMPOSE_FILE="$INTEGRATION_DIR/docker-compose.test.yaml"

echo "[up.sh] Bringing up test postgres + redis (project: ${INT_PROJECT_NAME}, pg:${INT_PG_PORT} redis:${INT_REDIS_PORT})..."
docker compose -p "${INT_PROJECT_NAME}" -f "${COMPOSE_FILE}" up -d --wait

echo "[up.sh] Stack ready:"
docker compose -p "${INT_PROJECT_NAME}" -f "${COMPOSE_FILE}" ps
