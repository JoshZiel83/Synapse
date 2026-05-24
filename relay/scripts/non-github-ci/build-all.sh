#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"

requested_version=""
platforms_raw="all"
output_dir=""
windows_package_variants="all"
enable_dockur_macos=0
start_windows_vm=0
start_macos_vm=0
skip_linux_gui=0
run_vfs_validation=0

usage() {
  cat <<'EOF' >&2
Usage: build-all.sh [options]

Options:
  --version=<version>                  Version to inject. Defaults to dev-<sha>.
  --platforms=<all|list>               Comma/space list: linux-amd64,windows-amd64,darwin-amd64.
  --output-dir=<dir>                   Versioned artifact directory. Defaults to artifacts/relay/<version>.
  --windows-package-variants=<value>   all, portable, or setup. Default: all.
  --enable-dockur-macos                Allow staging/starting the dockur macOS worker.
  --start-windows-vm                   Start the dockur Windows container after staging.
  --start-macos-vm                     Start the dockur macOS container after staging. Requires --enable-dockur-macos.
  --skip-linux-gui                     Build CLI only for linux-amd64.
  --run-vfs-validation                 Run Linux relay VFS unit/build validation.
  --skip-submodule-update              Do not initialize submodules.
EOF
  exit 64
}

for arg in "$@"; do
  case "${arg}" in
    --version=*)
      requested_version="${arg#*=}"
      ;;
    --platforms=*)
      platforms_raw="${arg#*=}"
      ;;
    --output-dir=*)
      output_dir="${arg#*=}"
      ;;
    --windows-package-variants=*)
      windows_package_variants="${arg#*=}"
      ;;
    --enable-dockur-macos)
      enable_dockur_macos=1
      ;;
    --start-windows-vm)
      start_windows_vm=1
      ;;
    --start-macos-vm)
      start_macos_vm=1
      ;;
    --skip-linux-gui)
      skip_linux_gui=1
      ;;
    --run-vfs-validation)
      run_vfs_validation=1
      ;;
    --skip-submodule-update)
      export SKIP_SUBMODULE_UPDATE=1
      ;;
    -h | --help)
      usage
      ;;
    *)
      usage
      ;;
  esac
done

case "${windows_package_variants}" in
  all | portable | setup) ;;
  *) die "unsupported --windows-package-variants=${windows_package_variants}" ;;
esac

if [[ "${start_macos_vm}" == "1" && "${enable_dockur_macos}" != "1" ]]; then
  die "--start-macos-vm requires --enable-dockur-macos"
fi

version="$(resolve_version "${requested_version}")"
if [[ -z "${output_dir}" ]]; then
  output_dir="$(artifact_dir_for_version "${DEFAULT_ARTIFACT_ROOT}" "${version}")"
fi
ensure_artifact_dirs "${output_dir}"

mapfile -t platforms < <(normalize_platforms "${platforms_raw}")
if [[ "${#platforms[@]}" -eq 0 ]]; then
  die "no platforms selected"
fi

log "version: ${version}"
log "output: ${output_dir}"
log "platforms: ${platforms[*]}"

ensure_submodules

for platform in "${platforms[@]}"; do
  "${SCRIPT_DIR}/prepare-bundle.sh" \
    --platform="${platform}" \
    --output-dir="${output_dir}" \
    --skip-submodule-update

  cli_args=(
    "--platform=${platform}"
    "--version=${version}"
    "--output-dir=${output_dir}"
    "--runtime-bundle=$(runtime_archive_path "${output_dir}" "${platform}")"
    "--skip-prepare-bundle"
  )
  if [[ "${platform}" == "linux-amd64" && "${run_vfs_validation}" == "1" ]]; then
    cli_args+=("--run-vfs-validation")
  fi
  "${SCRIPT_DIR}/build-cli.sh" "${cli_args[@]}"
done

if printf '%s\n' "${platforms[@]}" | grep -qx 'linux-amd64'; then
  if [[ "${skip_linux_gui}" == "1" ]]; then
    log "skipping Linux GUI because --skip-linux-gui was set"
  else
    "${SCRIPT_DIR}/build-gui-linux.sh" \
      --version="${version}" \
      --output-dir="${output_dir}" \
      --runtime-bundle="$(runtime_archive_path "${output_dir}" "linux-amd64")" \
      --skip-prepare-bundle
  fi
fi

stage_dir="${output_dir}/vm"
mkdir -p "${stage_dir}"

if printf '%s\n' "${platforms[@]}" | grep -qx 'windows-amd64'; then
  cat >"${stage_dir}/run-windows-gui-build.ps1" <<EOF
\$ErrorActionPreference = 'Stop'
\$RepoRoot = (Resolve-Path (Join-Path \$PSScriptRoot '..\\..\\..\\..')).Path
\$OutputDir = Join-Path \$RepoRoot 'artifacts\\relay\\${version}'
\$Script = Join-Path \$RepoRoot 'relay\\scripts\\non-github-ci\\build-gui-windows.ps1'
& \$Script -Version '${version}' -OutputDir \$OutputDir -RuntimeBundle (Join-Path \$OutputDir 'runtime\\relay-runtime-bundle-windows-amd64.tar.gz') -WindowsPackageVariants '${windows_package_variants}' -SkipPrepareBundle -SkipSubmoduleUpdate
EOF
  log "Windows GUI worker command staged: ${stage_dir}/run-windows-gui-build.ps1"
fi

if printf '%s\n' "${platforms[@]}" | grep -qx 'darwin-amd64'; then
  if [[ "${enable_dockur_macos}" == "1" ]]; then
    cat >"${stage_dir}/run-macos-gui-build.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")/../../../.." && pwd)"
"\${REPO_ROOT}/relay/scripts/non-github-ci/build-gui-macos.sh" \\
  --version="${version}" \\
  --output-dir="\${REPO_ROOT}/artifacts/relay/${version}" \\
  --runtime-bundle="\${REPO_ROOT}/artifacts/relay/${version}/runtime/relay-runtime-bundle-darwin-amd64.tar.gz" \\
  --skip-prepare-bundle
EOF
    chmod +x "${stage_dir}/run-macos-gui-build.sh"
    log "macOS GUI worker command staged: ${stage_dir}/run-macos-gui-build.sh"
  else
    warn "darwin-amd64 CLI was built, but macOS GUI staging requires --enable-dockur-macos"
  fi
fi

if [[ "${start_windows_vm}" == "1" || "${start_macos_vm}" == "1" ]]; then
  require_cmd docker
  docker compose version >/dev/null 2>&1 || die "docker compose plugin is unavailable"
  export SYNAPSE_RELAY_VM_SHARED="${REPO_ROOT}"
  compose_file="${SCRIPT_DIR}/docker-compose.yml"
  if [[ "${start_windows_vm}" == "1" ]]; then
    log "starting dockur Windows worker"
    docker compose -f "${compose_file}" up -d windows
  fi
  if [[ "${start_macos_vm}" == "1" ]]; then
    log "starting dockur macOS worker"
    docker compose -f "${compose_file}" up -d macos
  fi
fi

log "build orchestration complete"
log "artifacts: ${output_dir}"
