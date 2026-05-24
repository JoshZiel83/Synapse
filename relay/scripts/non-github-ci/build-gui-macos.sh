#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"

version=""
output_dir=""
runtime_archive=""
prepare_bundle=1

usage() {
  cat <<'EOF' >&2
Usage: build-gui-macos.sh --version=<version> [options]

Run this on a licensed macOS x86_64 builder.

Options:
  --output-dir=<dir>       Versioned artifact directory. Defaults to artifacts/relay/<version>.
  --runtime-bundle=<file>  Use a prepared darwin-amd64 runtime bundle tarball.
  --skip-prepare-bundle    Require --runtime-bundle or already-prepared assets.
EOF
  exit 64
}

for arg in "$@"; do
  case "${arg}" in
    --version=*)
      version="${arg#*=}"
      ;;
    --output-dir=*)
      output_dir="${arg#*=}"
      ;;
    --runtime-bundle=*)
      runtime_archive="${arg#*=}"
      ;;
    --skip-prepare-bundle)
      prepare_bundle=0
      ;;
    -h | --help)
      usage
      ;;
    *)
      usage
      ;;
  esac
done

[[ -n "${version}" ]] || usage

platform="darwin-amd64"
if [[ -z "${output_dir}" ]]; then
  output_dir="$(artifact_dir_for_version "${DEFAULT_ARTIFACT_ROOT}" "${version}")"
fi
ensure_artifact_dirs "${output_dir}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  die "macOS GUI builds must run on macOS"
fi
if [[ "$(uname -m)" != "x86_64" ]]; then
  die "this script builds darwin-amd64 and must run on an x86_64 macOS builder"
fi

require_cmd go
require_cmd node
require_cmd npm
require_cmd ditto
require_cmd hdiutil
require_cmd pkgbuild
require_cmd osascript
require_cmd tar
require_cmd python3
install_wails_if_missing

if [[ -z "${runtime_archive}" ]]; then
  runtime_archive="$(runtime_archive_path "${output_dir}" "${platform}")"
fi

if [[ "${prepare_bundle}" == "1" && ! -f "${runtime_archive}" ]]; then
  "${SCRIPT_DIR}/prepare-bundle.sh" --platform="${platform}" --output-dir="${output_dir}"
fi

runtime_ready=0
if verify_prepared_runtime "${platform}" >/dev/null 2>&1; then
  log "runtime bundle manifests are already ready for ${platform}"
  runtime_ready=1
fi

if [[ "${runtime_ready}" != "1" && -f "${runtime_archive}" ]]; then
  extract_runtime_archive "${runtime_archive}"
fi
verify_prepared_runtime "${platform}"

macos_cli_artifact="${output_dir}/cli/synapse-relay-darwin-amd64"
if [[ -f "${macos_cli_artifact}" ]]; then
  log "using existing macOS CLI smoke artifact ${macos_cli_artifact}"
else
  log "building macOS CLI smoke artifact"
  (
    cd "${RELAY_ROOT}"
    CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 \
      go build -ldflags="-s -w -X main.Version=${version}" \
      -o "${macos_cli_artifact}" ./cmd/synapse-relay
  )
fi

log "preparing macOS GUI build assets"
(
  cd "${RELAY_ROOT}"
  node scripts/prepare-gui-build-assets.mjs --goos=darwin --runtime-mode=portable
)

log "preparing macOS frontend dependencies"
(
  cd "${RELAY_ROOT}/cmd/synapse-relay-gui/frontend"
  marker="node_modules/.synapse-relay-platform"
  if [[ ! -x "node_modules/.bin/vite" || ! -f "${marker}" || "$(cat "${marker}" 2>/dev/null)" != "${platform}" ]]; then
    rm -rf node_modules
    npm install
    mkdir -p node_modules
    printf '%s\n' "${platform}" >"${marker}"
  fi
)

log "building macOS GUI"
(
  cd "${RELAY_ROOT}/cmd/synapse-relay-gui"
  CGO_LDFLAGS_ALLOW='^(-weak_framework|ScreenCaptureKit)$' wails build \
    -tags "desktop_cua,relay_packaged_runtime" \
    -ldflags="-s -w -X main.Version=${version}"
)

log "packaging macOS GUI artifacts"
(
  cd "${output_dir}/gui"
  bash "${RELAY_ROOT}/scripts/package-gui-macos.sh" \
    --app-path="${RELAY_ROOT}/cmd/synapse-relay-gui/build/bin/Synapse Relay.app" \
    --suffix="${platform}"
)

log "macOS GUI artifacts ready under ${output_dir}/gui"
