#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"

platform=""
version=""
output_dir=""
runtime_archive=""
prepare_bundle=1
run_vfs_validation=0

usage() {
  cat <<'EOF' >&2
Usage: build-cli.sh --platform=<linux-amd64|windows-amd64|darwin-amd64> --version=<version> [options]

Options:
  --output-dir=<dir>       Versioned artifact directory. Defaults to artifacts/relay/<version>.
  --runtime-bundle=<file>  Use a prepared runtime bundle tarball.
  --skip-prepare-bundle    Require --runtime-bundle or already-prepared assets.
  --run-vfs-validation     On linux-amd64, run relay/scripts/validate-vfs-unit.sh.
EOF
  exit 64
}

for arg in "$@"; do
  case "${arg}" in
    --platform=*)
      platform="${arg#*=}"
      ;;
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
    --run-vfs-validation)
      run_vfs_validation=1
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
[[ -n "${version}" ]] || usage

case "${platform}" in
  linux-amd64 | windows-amd64 | darwin-amd64) ;;
  *) die "unsupported platform: ${platform}" ;;
esac

if [[ -z "${output_dir}" ]]; then
  output_dir="$(artifact_dir_for_version "${DEFAULT_ARTIFACT_ROOT}" "${version}")"
fi
ensure_artifact_dirs "${output_dir}"

require_cmd go
require_cmd node
require_cmd tar

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

goos="$(platform_goos "${platform}")"
goarch="$(platform_goarch "${platform}")"
ext="$(platform_ext "${platform}")"
cli_output="${output_dir}/cli/synapse-relay-${platform}${ext}"

log "building CLI ${platform}"
(
  cd "${RELAY_ROOT}"
  CGO_ENABLED=0 GOOS="${goos}" GOARCH="${goarch}" \
    go build -ldflags="-s -w -X main.Version=${version}" \
    -o "${cli_output}" ./cmd/synapse-relay
)

if [[ "${platform}" == "linux-amd64" ]]; then
  mount_output="${output_dir}/cli/synapse-relay-mount-linux-amd64"
  log "building Linux mount helper"
  (
    cd "${RELAY_ROOT}"
    CGO_ENABLED=1 GOOS=linux GOARCH=amd64 \
      go build -tags 'relay_fuse,desktop_cua' \
      -ldflags="-s -w -X main.Version=${version}" \
      -o "${mount_output}" ./cmd/synapse-relay-mount
  )

  if [[ "${run_vfs_validation}" == "1" ]]; then
    log "running Relay VFS unit/build validation"
    (
      cd "${RELAY_ROOT}"
      bash scripts/validate-vfs-unit.sh
    )
  fi
fi

log "CLI artifact ready: ${cli_output}"
