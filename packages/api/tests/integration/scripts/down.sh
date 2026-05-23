#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTEGRATION_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_NAME="synapse-int-test"
COMPOSE_FILE="$INTEGRATION_DIR/docker-compose.test.yaml"

KEEP_VOLUMES="${KEEP_VOLUMES:-0}"

echo "[down.sh] Stopping test stack (project: ${PROJECT_NAME})..."
if [[ "${KEEP_VOLUMES}" == "1" ]]; then
  docker compose -p "${PROJECT_NAME}" -f "${COMPOSE_FILE}" down
else
  docker compose -p "${PROJECT_NAME}" -f "${COMPOSE_FILE}" down -v
fi

echo "[down.sh] Done."
