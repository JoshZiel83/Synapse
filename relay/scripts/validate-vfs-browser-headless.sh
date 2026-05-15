#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/validation-common.sh"

require_cmd curl
require_cmd go
require_cmd python3

prepare_validation_browser_runtime

WORK_DIR="$(make_validation_dir)"
HTTP_PID=""
cleanup() {
  if [[ -n "${HTTP_PID}" ]]; then
    kill "${HTTP_PID}" >/dev/null 2>&1 || true
    wait "${HTTP_PID}" >/dev/null 2>&1 || true
  fi
  if [[ "${VALIDATE_KEEP_TMP:-0}" != "1" ]]; then
    rm -rf "${WORK_DIR}"
  else
    log "preserved validation workspace at ${WORK_DIR}"
  fi
}
trap cleanup EXIT

BROWSER_BIN="$(detect_browser_bin)"
PORT="$(pick_free_port)"
FIXTURE_DIR="${WORK_DIR}/fixture"
CONFIG_FILE="${WORK_DIR}/config.yaml"
SERVER_LOG="${WORK_DIR}/http.log"
FIXTURE_URL="http://127.0.0.1:${PORT}/"

write_validation_page "${FIXTURE_DIR}"
write_validation_config "${CONFIG_FILE}" "${BROWSER_BIN}" 0 "${WORK_DIR}"

HTTP_PID="$(start_http_server "${FIXTURE_DIR}" "${PORT}" "${SERVER_LOG}")"
wait_for_http "${FIXTURE_URL}"

log "running browser DOM validation against ${FIXTURE_URL}"

(
  cd "${RELAY_ROOT}"
  go run ./scripts/validate-vfs-browser-headless.go \
    --config "${CONFIG_FILE}" \
    --url "${FIXTURE_URL}" \
    --marker "${VALIDATION_MARKER}" \
    --placeholder "${VALIDATION_PLACEHOLDER}" \
    --button-text "${VALIDATION_BUTTON_TEXT}"
)

log "browser DOM validation passed"
