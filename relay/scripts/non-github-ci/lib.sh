#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELAY_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
REPO_ROOT="$(cd "${RELAY_ROOT}/.." && pwd)"

BUNDLED_NODE_VERSION="${BUNDLED_NODE_VERSION:-24.14.1}"
CHROME_DEVTOOLS_MCP_VERSION="${CHROME_DEVTOOLS_MCP_VERSION:-0.20.0}"
BUNDLED_PYTHON_VERSION="${BUNDLED_PYTHON_VERSION:-3.13.10}"
BUNDLED_PYTHON_STANDALONE_RELEASE="${BUNDLED_PYTHON_STANDALONE_RELEASE:-20251202}"
BUNDLED_WINDOWS_GIT_VERSION="${BUNDLED_WINDOWS_GIT_VERSION:-2.49.0.windows.1}"
BUNDLED_FFMPEG_RELEASE_TAG="${BUNDLED_FFMPEG_RELEASE_TAG:-n7.1-2}"
COMMANDLINE_PACKAGE_PROFILE="${COMMANDLINE_PACKAGE_PROFILE:-default-data-v5}"
PIP_INDEX_URL="${PIP_INDEX_URL:-https://pypi.org/simple}"
export PIP_INDEX_URL
NPM_CONFIG_REGISTRY="${NPM_CONFIG_REGISTRY:-https://registry.npmjs.org/}"
NPM_CONFIG_REPLACE_REGISTRY_HOST="${NPM_CONFIG_REPLACE_REGISTRY_HOST:-always}"
export NPM_CONFIG_REGISTRY NPM_CONFIG_REPLACE_REGISTRY_HOST
export npm_config_registry="${NPM_CONFIG_REGISTRY}"
export npm_config_replace_registry_host="${NPM_CONFIG_REPLACE_REGISTRY_HOST}"

DEFAULT_ARTIFACT_ROOT="${REPO_ROOT}/artifacts/relay"
ALL_X86_PLATFORMS=("linux-amd64" "windows-amd64" "darwin-amd64")

for path_candidate in \
  "${HOME:-}/.synapse-relay-build-tools/go/bin" \
  "${HOME:-}/.synapse-relay-build-tools/node/bin" \
  "${HOME:-}/go/bin"; do
  if [[ -n "${path_candidate}" && -d "${path_candidate}" ]]; then
    PATH="${path_candidate}:${PATH}"
  fi
done
export PATH

log() {
  printf '[relay-non-github-ci] %s\n' "$*"
}

warn() {
  printf '[relay-non-github-ci] WARNING: %s\n' "$*" >&2
}

die() {
  printf '[relay-non-github-ci] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

optional_cmd() {
  command -v "$1" >/dev/null 2>&1
}

resolve_version() {
  local requested="${1:-}"
  if [[ -n "${requested}" ]]; then
    printf '%s\n' "${requested}"
    return 0
  fi

  local sha
  sha="$(git -C "${REPO_ROOT}" rev-parse --short=8 HEAD 2>/dev/null || true)"
  if [[ -n "${sha}" ]]; then
    printf 'dev-%s\n' "${sha}"
  else
    printf 'dev\n'
  fi
}

platform_goos() {
  case "$1" in
    linux-amd64) printf 'linux\n' ;;
    windows-amd64) printf 'windows\n' ;;
    darwin-amd64) printf 'darwin\n' ;;
    *) die "unsupported platform: $1" ;;
  esac
}

platform_goarch() {
  case "$1" in
    linux-amd64 | windows-amd64 | darwin-amd64) printf 'amd64\n' ;;
    *) die "unsupported platform: $1" ;;
  esac
}

platform_ext() {
  case "$1" in
    windows-amd64) printf '.exe\n' ;;
    linux-amd64 | darwin-amd64) printf '\n' ;;
    *) die "unsupported platform: $1" ;;
  esac
}

normalize_platforms() {
  local raw="${1:-all}"
  raw="$(printf '%s' "${raw}" | tr '[:upper:]' '[:lower:]')"
  if [[ -z "${raw//[[:space:],]/}" || "${raw}" == "all" ]]; then
    printf '%s\n' "${ALL_X86_PLATFORMS[@]}"
    return 0
  fi

  local token
  local seen=" "
  tr ',[:space:]' '\n' <<<"${raw}" | while IFS= read -r token; do
    [[ -n "${token}" ]] || continue
    case "${token}" in
      linux-amd64 | windows-amd64 | darwin-amd64) ;;
      *) die "unsupported platform '${token}'. Use all, linux-amd64, windows-amd64, darwin-amd64." ;;
    esac
    if [[ "${seen}" != *" ${token} "* ]]; then
      printf '%s\n' "${token}"
      seen="${seen}${token} "
    fi
  done
}

artifact_dir_for_version() {
  local root="${1:-${DEFAULT_ARTIFACT_ROOT}}"
  local version="$2"
  printf '%s\n' "${root%/}/${version}"
}

runtime_archive_path() {
  local output_dir="$1"
  local platform="$2"
  printf '%s\n' "${output_dir%/}/runtime/relay-runtime-bundle-${platform}.tar.gz"
}

ensure_artifact_dirs() {
  local output_dir="$1"
  mkdir -p "${output_dir}/cli" "${output_dir}/gui" "${output_dir}/runtime" "${output_dir}/logs"
}

ensure_submodules() {
  if [[ "${SKIP_SUBMODULE_UPDATE:-0}" == "1" ]]; then
    log "skipping submodule update because SKIP_SUBMODULE_UPDATE=1"
    return 0
  fi
  log "initializing submodules"
  git -C "${REPO_ROOT}" submodule update --init --recursive
}

extract_runtime_archive() {
  local archive="$1"
  [[ -f "${archive}" ]] || die "runtime bundle archive not found: ${archive}"
  log "extracting runtime bundle ${archive}"
  tar -xzf "${archive}" -C "${REPO_ROOT}"
}

verify_prepared_runtime() {
  local platform="$1"
  python3 - "${RELAY_ROOT}" "${platform}" "${BUNDLED_NODE_VERSION}" "${CHROME_DEVTOOLS_MCP_VERSION}" <<'PY'
import json
import pathlib
import sys

relay_root = pathlib.Path(sys.argv[1])
platform = sys.argv[2]
node_version = sys.argv[3]
chrome_version = sys.argv[4]
expected_node = f"node-{node_version}-{platform}"

paths = {
    "node": relay_root / "internal/nodebundle/assets/manifest.json",
    "chrome": relay_root / "internal/chromemcpbundle/assets/manifest.json",
    "commandline": relay_root / "internal/commandlinebundle/assets/manifest.json",
}

manifests = {}
for name, path in paths.items():
    try:
        manifests[name] = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise SystemExit(f"{name} manifest is not readable: {exc}")

if manifests["node"].get("platform") != platform:
    raise SystemExit(f"node bundle platform mismatch: {manifests['node'].get('platform')} != {platform}")
if manifests["node"].get("assetVersion") != expected_node:
    raise SystemExit(f"node bundle assetVersion mismatch: {manifests['node'].get('assetVersion')} != {expected_node}")

if manifests["chrome"].get("platform") != platform:
    raise SystemExit(f"chrome bundle platform mismatch: {manifests['chrome'].get('platform')} != {platform}")
if manifests["chrome"].get("nodeAssetVersion") != expected_node:
    raise SystemExit("chrome bundle does not reference the prepared node bundle")
if manifests["chrome"].get("packageVersion") != chrome_version:
    raise SystemExit(f"chrome packageVersion mismatch: {manifests['chrome'].get('packageVersion')} != {chrome_version}")

if manifests["commandline"].get("platform") != platform:
    raise SystemExit(f"commandline bundle platform mismatch: {manifests['commandline'].get('platform')} != {platform}")
if manifests["commandline"].get("nodeAssetVersion") != expected_node:
    raise SystemExit("commandline bundle does not reference the prepared node bundle")

print(f"runtime bundle manifests are ready for {platform}")
PY
}

install_wails_if_missing() {
  require_cmd go
  if optional_cmd wails; then
    return 0
  fi
  log "installing Wails v2.11.0"
  go install github.com/wailsapp/wails/v2/cmd/wails@v2.11.0
  export PATH="$(go env GOPATH)/bin:${PATH}"
  require_cmd wails
}

copy_if_file() {
  local source="$1"
  local target_dir="$2"
  if [[ -f "${source}" ]]; then
    mkdir -p "${target_dir}"
    cp "${source}" "${target_dir}/"
  fi
}
