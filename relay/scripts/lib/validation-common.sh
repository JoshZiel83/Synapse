#!/usr/bin/env bash

set -euo pipefail

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  printf 'source this file from another script\n' >&2
  exit 1
fi

RELAY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO_ROOT="$(cd "${RELAY_ROOT}/.." && pwd)"
VALIDATION_MARKER="${VALIDATION_MARKER:-relayfs-dom-ok}"
VALIDATION_PLACEHOLDER="${VALIDATION_PLACEHOLDER:-RelayFS input marker}"
VALIDATION_BUTTON_TEXT="${VALIDATION_BUTTON_TEXT:-Apply marker}"
BUNDLED_NODE_VERSION="${BUNDLED_NODE_VERSION:-24.14.1}"
CHROME_DEVTOOLS_MCP_VERSION="${CHROME_DEVTOOLS_MCP_VERSION:-0.20.0}"
VALIDATION_RUNTIME_CHANGED="${VALIDATION_RUNTIME_CHANGED:-0}"

log() {
  printf '[relay-vfs-validate] %s\n' "$*"
}

die() {
  printf '[relay-vfs-validate] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

pick_free_port() {
  python3 - <<'PY'
import socket

sock = socket.socket()
sock.bind(("127.0.0.1", 0))
print(sock.getsockname()[1])
sock.close()
PY
}

detect_browser_bin() {
  if [[ -n "${VALIDATE_BROWSER_BIN:-}" ]]; then
    [[ -x "${VALIDATE_BROWSER_BIN}" ]] || die "VALIDATE_BROWSER_BIN is not executable: ${VALIDATE_BROWSER_BIN}"
    printf '%s\n' "${VALIDATE_BROWSER_BIN}"
    return 0
  fi

  local candidate
  for candidate in google-chrome-stable google-chrome chromium chromium-browser; do
    if command -v "${candidate}" >/dev/null 2>&1; then
      command -v "${candidate}"
      return 0
    fi
  done

  die "could not find a Chrome/Chromium binary; set VALIDATE_BROWSER_BIN=/path/to/browser"
}

make_validation_dir() {
  local parent="${VALIDATE_TMP_PARENT:-/tmp}"
  mkdir -p "${parent}"
  mktemp -d "${parent%/}/synapse-relay-vfs.XXXXXX"
}

write_validation_page() {
  local target_dir="$1"
  mkdir -p "${target_dir}"
  cat >"${target_dir}/index.html" <<EOF
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>RelayFS Validation</title>
  <style>
    body { font-family: sans-serif; padding: 24px; }
    input, button { font-size: 16px; padding: 8px 12px; }
    #result { margin-top: 20px; font-weight: 700; }
  </style>
</head>
<body>
  <h1>RelayFS Validation Fixture</h1>
  <label for="marker-input">Marker</label>
  <input id="marker-input" type="text" placeholder="${VALIDATION_PLACEHOLDER}" />
  <button id="apply-button" type="button">${VALIDATION_BUTTON_TEXT}</button>
  <div id="result">pending</div>
  <script>
    const input = document.getElementById('marker-input');
    const result = document.getElementById('result');
    document.getElementById('apply-button').addEventListener('click', () => {
      result.textContent = input.value.trim();
    });
  </script>
</body>
</html>
EOF
}

write_validation_config() {
  local target_file="$1"
  local browser_bin="$2"
  local include_cua="$3"
  local workspace_dir="$4"

  mkdir -p "${workspace_dir}"
  : >"${workspace_dir}/device-key.pem"

  cat >"${target_file}" <<EOF
relay:
  server_base_url: "http://127.0.0.1:3001"
  websocket_url: "ws://127.0.0.1:3001/ws/relay"
  device_id: "relay-vfs-validation"
  private_key_path: "${workspace_dir}/device-key.pem"
log_level: "debug"
servers:
  - name: "browser"
    transport: "builtin"
    builtin:
      kind: "chrome"
      instance_id: "chrome_default"
      chrome:
        connection_mode: "managed"
        executable_path: "${browser_bin}"
        user_data_dir: "${workspace_dir}/chrome-profile"
        headless: true
        isolated: true
        slim: true
        usage_statistics: false
        performance_crux: false
        chrome_args:
          - "--no-sandbox"
          - "--disable-dev-shm-usage"
EOF

  if [[ "${include_cua}" == "1" ]]; then
    cat >>"${target_file}" <<EOF
  - name: "computer-use"
    transport: "builtin"
    builtin:
      kind: "cua"
      instance_id: "cua_default"
      cua:
        read_only: false
        display_selector:
          mode: "main"
EOF
  fi
}

start_http_server() {
  local content_dir="$1"
  local port="$2"
  local log_file="$3"
  python3 -m http.server "${port}" --bind 127.0.0.1 --directory "${content_dir}" >"${log_file}" 2>&1 &
  printf '%s\n' "$!"
}

wait_for_http() {
  local url="$1"
  local attempts="${2:-80}"
  local delay="${3:-0.25}"
  local i
  for ((i = 0; i < attempts; i += 1)); do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep "${delay}"
  done
  die "timed out waiting for ${url}"
}

wait_for_mount_ready() {
  local mountpoint="$1"
  local attempts="${2:-120}"
  local delay="${3:-0.25}"
  local i
  for ((i = 0; i < attempts; i += 1)); do
    if [[ -d "${mountpoint}/browser" && -d "${mountpoint}/cua" ]]; then
      return 0
    fi
    sleep "${delay}"
  done
  die "timed out waiting for FUSE mount at ${mountpoint}"
}

build_validation_binaries() {
  if [[ "${VALIDATE_SKIP_BUILD:-0}" == "1" && "${VALIDATION_RUNTIME_CHANGED}" != "1" ]]; then
    log "skipping binary build because VALIDATE_SKIP_BUILD=1"
    return 0
  fi
  if [[ "${VALIDATE_SKIP_BUILD:-0}" == "1" && "${VALIDATION_RUNTIME_CHANGED}" == "1" ]]; then
    log "runtime bundle changed; rebuilding binaries even though VALIDATE_SKIP_BUILD=1"
  fi
  (
    cd "${RELAY_ROOT}"
    make cli cli-desktop mount-fuse
  )
}

host_platform() {
  local goos
  local goarch
  goos="$(go env GOOS)"
  goarch="$(go env GOARCH)"
  printf '%s-%s\n' "${goos}" "${goarch}"
}

browser_runtime_ready() {
  local target_platform="$1"
  python3 - "${RELAY_ROOT}/internal/nodebundle/assets/manifest.json" "${RELAY_ROOT}/internal/chromemcpbundle/assets/manifest.json" "${target_platform}" "${BUNDLED_NODE_VERSION}" "${CHROME_DEVTOOLS_MCP_VERSION}" <<'PY'
import json
import pathlib
import sys

node_manifest_path = pathlib.Path(sys.argv[1])
chrome_manifest_path = pathlib.Path(sys.argv[2])
target_platform = sys.argv[3]
node_version = sys.argv[4]
chrome_package_version = sys.argv[5]

expected_node_asset = f"node-{node_version}-{target_platform}"

try:
    node_manifest = json.loads(node_manifest_path.read_text(encoding="utf-8"))
    chrome_manifest = json.loads(chrome_manifest_path.read_text(encoding="utf-8"))
except FileNotFoundError:
    raise SystemExit(1)

if not node_manifest.get("prepared"):
    raise SystemExit(1)
if node_manifest.get("platform") != target_platform:
    raise SystemExit(1)
if node_manifest.get("assetVersion") != expected_node_asset:
    raise SystemExit(1)
if not chrome_manifest.get("prepared"):
    raise SystemExit(1)
if chrome_manifest.get("platform") != target_platform:
    raise SystemExit(1)
if chrome_manifest.get("nodeAssetVersion") != expected_node_asset:
    raise SystemExit(1)
if chrome_manifest.get("packageVersion") != chrome_package_version:
    raise SystemExit(1)
PY
}

prepare_validation_browser_runtime() {
  require_cmd go
  require_cmd node

  local target_platform
  target_platform="$(host_platform)"

  if browser_runtime_ready "${target_platform}"; then
    log "bundled browser runtime already prepared for ${target_platform}"
    return 0
  fi

  log "preparing bundled browser runtime for ${target_platform}"
  (
    cd "${RELAY_ROOT}"
    node scripts/prepare-node-bundle.mjs --target-platform="${target_platform}" --node-version="${BUNDLED_NODE_VERSION}"
    node scripts/prepare-chrome-devtools-bundle.mjs --target-platform="${target_platform}" --node-version="${BUNDLED_NODE_VERSION}" --package-version="${CHROME_DEVTOOLS_MCP_VERSION}"
  )
  VALIDATION_RUNTIME_CHANGED="1"
}

vfs_list_first_name() {
  local binary="$1"
  local config_file="$2"
  local target="$3"
  "${binary}" vfs -c "${config_file}" --json ls "${target}" | python3 -c '
import json
import sys

entries = json.load(sys.stdin)
if not entries:
    raise SystemExit("no entries found")
print(entries[0]["name"])
'
}

browser_tree_action_paths() {
  local tree_json="$1"
  python3 - "${tree_json}" "${VALIDATION_PLACEHOLDER}" "${VALIDATION_BUTTON_TEXT}" <<'PY'
import json
import sys

tree_path, placeholder, button_text = sys.argv[1:]
with open(tree_path, encoding="utf-8") as handle:
    payload = json.load(handle)

if payload.get("backend") != "dom":
    raise SystemExit(f"expected backend=dom, got {payload.get('backend')!r}")
if int(payload.get("nodeCount", 0)) <= 0:
    raise SystemExit("expected nodeCount > 0")

fill_path = None
click_path = None
for node in payload.get("nodes", []):
    actions = set(node.get("actions") or [])
    attrs = node.get("attributes") or {}
    tag = (node.get("tag") or "").lower()
    summary_parts = [
        str(node.get("name") or ""),
        str(node.get("text") or ""),
        str(node.get("summary") or ""),
    ]
    summary = " ".join(summary_parts)
    path_id = node.get("pathId") or node.get("id")

    if fill_path is None and "fill" in actions and tag == "input" and attrs.get("placeholder") == placeholder:
        fill_path = path_id
    if click_path is None and "click" in actions and tag == "button" and button_text in summary:
        click_path = path_id

if not fill_path:
    raise SystemExit("could not find fillable validation input node")
if not click_path:
    raise SystemExit("could not find clickable validation button node")

print(fill_path)
print(click_path)
PY
}

assert_tree_contains_marker() {
  local tree_json="$1"
  local marker="${2:-${VALIDATION_MARKER}}"
  python3 - "${tree_json}" "${marker}" <<'PY'
import json
import sys

tree_path, marker = sys.argv[1:]
with open(tree_path, encoding="utf-8") as handle:
    payload = json.load(handle)

for node in payload.get("nodes", []):
    haystacks = [
        str(node.get("name") or ""),
        str(node.get("text") or ""),
        str(node.get("summary") or ""),
    ]
    if any(marker in value for value in haystacks):
        raise SystemExit(0)

raise SystemExit(f"marker {marker!r} not found in DOM tree")
PY
}

assert_cua_headless_fallback() {
  local json_file="$1"
  python3 - "${json_file}" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    payload = json.load(handle)

if payload.get("supported") not in (False, 0):
    raise SystemExit(f"expected supported=false, got {payload.get('supported')!r}")
if payload.get("backend") != "atspi":
    raise SystemExit(f"expected backend='atspi', got {payload.get('backend')!r}")
message = str(payload.get("message") or "")
if "AT-SPI" not in message and "pyatspi" not in message:
    raise SystemExit(f"unexpected CUA fallback message: {message!r}")
PY
}
