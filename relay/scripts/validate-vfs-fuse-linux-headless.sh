#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/validation-common.sh"

[[ "$(uname -s)" == "Linux" ]] || die "this script is for Linux only"

require_cmd curl
require_cmd python3
require_cmd stat

prepare_validation_browser_runtime
build_validation_binaries

WORK_DIR="$(make_validation_dir)"
HTTP_PID=""
MOUNT_PID=""
cleanup() {
  if [[ -n "${MOUNT_PID}" ]]; then
    "${RELAY_ROOT}/synapse-relay-mount" unmount "${WORK_DIR}/mount" >/dev/null 2>&1 || true
    kill "${MOUNT_PID}" >/dev/null 2>&1 || true
    wait "${MOUNT_PID}" >/dev/null 2>&1 || true
  fi
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
MOUNT_LOG="${WORK_DIR}/mount.log"
DOCTOR_JSON="${WORK_DIR}/doctor.json"
TREE_JSON="${WORK_DIR}/tree.json"
TREE_AFTER_JSON="${WORK_DIR}/tree-after.json"
CUA_ROOT_JSON="${WORK_DIR}/cua-root.json"
CUA_FOCUSED_JSON="${WORK_DIR}/cua-focused.json"
MOUNT_DIR="${WORK_DIR}/mount"
FIXTURE_URL="http://127.0.0.1:${PORT}/"

mkdir -p "${MOUNT_DIR}"
write_validation_page "${FIXTURE_DIR}"
write_validation_config "${CONFIG_FILE}" "${BROWSER_BIN}" 1 "${WORK_DIR}"

"${RELAY_ROOT}/synapse-relay-mount" doctor >"${DOCTOR_JSON}"
python3 - "${DOCTOR_JSON}" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    payload = json.load(handle)

if payload.get("platform") != "linux":
    raise SystemExit(f"expected platform=linux, got {payload.get('platform')!r}")
checks = payload.get("dependencyChecks") or []
failed = [check for check in checks if not check.get("ok")]
if failed:
    raise SystemExit(f"doctor reported failed checks: {failed!r}")
PY

HTTP_PID="$(start_http_server "${FIXTURE_DIR}" "${PORT}" "${SERVER_LOG}")"
wait_for_http "${FIXTURE_URL}"

log "mounting relay FUSE filesystem at ${MOUNT_DIR}"
"${RELAY_ROOT}/synapse-relay-mount" mount -c "${CONFIG_FILE}" "${MOUNT_DIR}" >"${MOUNT_LOG}" 2>&1 &
MOUNT_PID="$!"
wait_for_mount_ready "${MOUNT_DIR}"

BROWSER_KEY="$(basename "$(find "${MOUNT_DIR}/browser" -mindepth 1 -maxdepth 1 -type d | sort | head -n 1)")"
CUA_KEY="$(basename "$(find "${MOUNT_DIR}/cua" -mindepth 1 -maxdepth 1 -type d | sort | head -n 1)")"
[[ -n "${BROWSER_KEY}" ]] || die "browser exposure was not mounted"
[[ -n "${CUA_KEY}" ]] || die "cua exposure was not mounted"

BROWSER_SESSION_ROOT="${MOUNT_DIR}/browser/${BROWSER_KEY}/sessions/default"
CUA_SESSION_ROOT="${MOUNT_DIR}/cua/${CUA_KEY}/sessions/default"

printf '%s\n' "${FIXTURE_URL}" >"${BROWSER_SESSION_ROOT}/actions/new_page"
python3 - "${BROWSER_SESSION_ROOT}/state.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    payload = json.load(handle)

if int(payload.get("selectedPageId", 0)) <= 0:
    raise SystemExit(f"expected selectedPageId > 0, got {payload.get('selectedPageId')!r}")
PY

cp "${BROWSER_SESSION_ROOT}/tree/index.json" "${TREE_JSON}"
mapfile -t NODE_PATHS < <(browser_tree_action_paths "${TREE_JSON}")
FILL_NODE_PATH_ID="${NODE_PATHS[0]}"
CLICK_NODE_PATH_ID="${NODE_PATHS[1]}"

printf '%s\n' "${VALIDATION_MARKER}" >"${BROWSER_SESSION_ROOT}/tree/nodes/${FILL_NODE_PATH_ID}/actions/fill"
printf '{}\n' >"${BROWSER_SESSION_ROOT}/tree/nodes/${CLICK_NODE_PATH_ID}/actions/click"
cp "${BROWSER_SESSION_ROOT}/tree/index.json" "${TREE_AFTER_JSON}"

assert_tree_contains_marker "${TREE_AFTER_JSON}" "${VALIDATION_MARKER}"

python3 - "${BROWSER_SESSION_ROOT}/pages/list.json" "${BROWSER_SESSION_ROOT}/current/page.json" "${BROWSER_SESSION_ROOT}/tree/index.json" <<'PY'
import pathlib
import sys

for candidate in sys.argv[1:]:
    path = pathlib.Path(candidate)
    if not path.is_file():
        raise SystemExit(f"expected file to exist: {path}")
    if path.stat().st_size <= 0:
        raise SystemExit(f"expected file to be non-empty: {path}")
PY

cp "${CUA_SESSION_ROOT}/tree/root.json" "${CUA_ROOT_JSON}"
cp "${CUA_SESSION_ROOT}/focused/props.json" "${CUA_FOCUSED_JSON}"
assert_cua_headless_fallback "${CUA_ROOT_JSON}"
assert_cua_headless_fallback "${CUA_FOCUSED_JSON}"

log "FUSE browser/CUA headless validation passed"
