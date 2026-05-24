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
Usage: build-gui-linux.sh --version=<version> [options]

Options:
  --output-dir=<dir>       Versioned artifact directory. Defaults to artifacts/relay/<version>.
  --runtime-bundle=<file>  Use a prepared linux-amd64 runtime bundle tarball.
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

platform="linux-amd64"
if [[ -z "${output_dir}" ]]; then
  output_dir="$(artifact_dir_for_version "${DEFAULT_ARTIFACT_ROOT}" "${version}")"
fi
ensure_artifact_dirs "${output_dir}"

require_cmd go
require_cmd node
require_cmd npm
require_cmd bash
require_cmd curl
require_cmd tar
require_cmd dpkg-deb
require_cmd patchelf
require_cmd mksquashfs
if ! optional_cmd magick && ! optional_cmd convert; then
  die "missing ImageMagick command: install either 'magick' or 'convert'"
fi
install_wails_if_missing

if [[ -z "${runtime_archive}" ]]; then
  runtime_archive="$(runtime_archive_path "${output_dir}" "${platform}")"
fi

if [[ "${prepare_bundle}" == "1" && ! -f "${runtime_archive}" ]]; then
  "${SCRIPT_DIR}/prepare-bundle.sh" --platform="${platform}" --output-dir="${output_dir}"
fi

if [[ -f "${runtime_archive}" ]]; then
  extract_runtime_archive "${runtime_archive}"
fi
verify_prepared_runtime "${platform}"

log "preparing Linux GUI build assets"
(
  cd "${RELAY_ROOT}"
  node scripts/prepare-gui-build-assets.mjs --goos=linux --runtime-mode=portable
)

log "building Linux GUI"
(
  cd "${RELAY_ROOT}/cmd/synapse-relay-gui"
  CGO_LDFLAGS_ALLOW="" wails build \
    -tags "desktop_cua,webkit2_41,relay_packaged_runtime" \
    -ldflags="-s -w -X main.Version=${version}"
)

log "packaging Linux GUI artifacts"
(
  cd "${output_dir}/gui"
  bash "${RELAY_ROOT}/scripts/package-gui-linux.sh" \
    --binary-path="${RELAY_ROOT}/cmd/synapse-relay-gui/build/bin/synapse-relay-gui" \
    --suffix="${platform}" \
    --version="${version}"
)

log "Linux GUI artifacts ready under ${output_dir}/gui"
