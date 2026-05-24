#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"

include_vms=0
check_linux_gui=1

usage() {
  cat <<'EOF' >&2
Usage: preflight.sh [--include-vms] [--no-linux-gui]

Checks the host tools needed by the non-GitHub Relay build scripts.
EOF
  exit 64
}

for arg in "$@"; do
  case "${arg}" in
    --include-vms)
      include_vms=1
      ;;
    --no-linux-gui)
      check_linux_gui=0
      ;;
    -h | --help)
      usage
      ;;
    *)
      usage
      ;;
  esac
done

missing=0

check_cmd() {
  local command="$1"
  if optional_cmd "${command}"; then
    log "found ${command}: $(command -v "${command}")"
  else
    warn "missing command: ${command}"
    missing=1
  fi
}

check_pkg_config() {
  local module="$1"
  if pkg-config --exists "${module}" 2>/dev/null; then
    log "found pkg-config module ${module}"
  else
    warn "missing pkg-config module: ${module}"
    missing=1
  fi
}

log "repo root: ${REPO_ROOT}"
log "relay root: ${RELAY_ROOT}"

check_cmd git
check_cmd node
check_cmd npm
check_cmd python3
check_cmd tar
check_cmd unzip
check_cmd 7z
check_cmd go

if [[ "${check_linux_gui}" == "1" ]]; then
  check_cmd curl
  check_cmd dpkg-deb
  check_cmd patchelf
  check_cmd mksquashfs
  if ! optional_cmd magick && ! optional_cmd convert; then
    warn "missing ImageMagick command: install either 'magick' or 'convert'"
    missing=1
  fi
  check_pkg_config gtk+-3.0
  check_pkg_config webkit2gtk-4.1
fi

if [[ -d "${REPO_ROOT}/subprojects/cli-anything/.git" || -f "${REPO_ROOT}/subprojects/cli-anything/.git" ]]; then
  log "submodules appear initialized"
else
  warn "submodules are not initialized; run: git submodule update --init --recursive"
  missing=1
fi

if [[ "${include_vms}" == "1" ]]; then
  if [[ -e /dev/kvm ]]; then
    log "found /dev/kvm"
  else
    warn "missing /dev/kvm"
    missing=1
  fi
  if [[ -e /dev/net/tun ]]; then
    log "found /dev/net/tun"
  else
    warn "missing /dev/net/tun"
    missing=1
  fi
  check_cmd docker
  if docker compose version >/dev/null 2>&1; then
    log "found docker compose"
  else
    warn "docker compose plugin is unavailable"
    missing=1
  fi
fi

if [[ "${missing}" != "0" ]]; then
  die "preflight checks failed"
fi

log "preflight checks passed"
