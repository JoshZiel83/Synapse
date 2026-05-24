#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"

platform=""
output_dir="${DEFAULT_ARTIFACT_ROOT}/runtime-cache"
init_submodules=1

usage() {
  cat <<'EOF' >&2
Usage: prepare-bundle.sh --platform=<linux-amd64|windows-amd64|darwin-amd64> [--output-dir=<dir>] [--skip-submodule-update]

Prepares the Node, Chrome DevTools MCP, and commandline runtime payloads for a
single target platform, then archives them as runtime/relay-runtime-bundle-<platform>.tar.gz.
EOF
  exit 64
}

for arg in "$@"; do
  case "${arg}" in
    --platform=*)
      platform="${arg#*=}"
      ;;
    --output-dir=*)
      output_dir="${arg#*=}"
      ;;
    --skip-submodule-update)
      init_submodules=0
      ;;
    -h | --help)
      usage
      ;;
    *)
      usage
      ;;
  esac
done

[[ -n "${platform}" ]] || usage
case "${platform}" in
  linux-amd64 | windows-amd64 | darwin-amd64) ;;
  *) die "unsupported platform: ${platform}" ;;
esac

require_cmd node
require_cmd npm
require_cmd python3
require_cmd tar
require_cmd unzip
require_cmd 7z

if [[ "${init_submodules}" == "1" ]]; then
  ensure_submodules
fi

ensure_artifact_dirs "${output_dir}"
archive="$(runtime_archive_path "${output_dir}" "${platform}")"

log "preparing runtime bundles for ${platform}"
(
  cd "${RELAY_ROOT}"
  node scripts/prepare-node-bundle.mjs \
    --target-platform="${platform}" \
    --node-version="${BUNDLED_NODE_VERSION}"
  node scripts/prepare-chrome-devtools-bundle.mjs \
    --target-platform="${platform}" \
    --node-version="${BUNDLED_NODE_VERSION}" \
    --package-version="${CHROME_DEVTOOLS_MCP_VERSION}"
  node scripts/prepare-commandline-bundle.mjs \
    --target-platform="${platform}" \
    --node-version="${BUNDLED_NODE_VERSION}" \
    --python-version="${BUNDLED_PYTHON_VERSION}" \
    --python-standalone-release="${BUNDLED_PYTHON_STANDALONE_RELEASE}" \
    --windows-git-version="${BUNDLED_WINDOWS_GIT_VERSION}" \
    --ffmpeg-release-tag="${BUNDLED_FFMPEG_RELEASE_TAG}" \
    --package-profile="${COMMANDLINE_PACKAGE_PROFILE}"
)

verify_prepared_runtime "${platform}"

mkdir -p "$(dirname "${archive}")"
rm -f "${archive}"
(
  cd "${REPO_ROOT}"
  tar -czf "${archive}" \
    relay/internal/nodebundle/assets \
    relay/internal/chromemcpbundle/assets \
    relay/internal/commandlinebundle/assets
)

log "runtime bundle archived: ${archive}"
