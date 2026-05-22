#!/usr/bin/env bash
# Tear down THIS worktree's staging stack and release its ports.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/staging-env.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

echo "Stopping ${COMPOSE_PROJECT_NAME} ..."
docker compose -f "${SYNAPSE_STAGING_COMPOSE_FILE}" --profile staging down -v --remove-orphans || true

ENV_FILE="${REPO_ROOT}/.env.staging.local"
if [[ "${1:-}" == "--keep-env" ]]; then
  echo "Kept ${ENV_FILE}"
else
  rm -f "${ENV_FILE}"
  echo "Removed ${ENV_FILE}"
fi
