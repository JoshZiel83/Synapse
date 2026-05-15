#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"${SCRIPT_DIR}/validate-vfs-unit.sh"
VALIDATE_SKIP_BUILD=1 "${SCRIPT_DIR}/validate-vfs-browser-headless.sh"
VALIDATE_SKIP_BUILD=1 "${SCRIPT_DIR}/validate-vfs-fuse-linux-headless.sh"
