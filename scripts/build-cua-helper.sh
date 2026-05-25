#!/usr/bin/env bash
set -euo pipefail

# Build the synapse-device-cua-helper Go sidecar. Used by the root
# `npm run build:cua-helper` script so the binary is available next to the
# TypeScript runtime when a packaged release ships.
#
# Graceful fallback: if Go isn't installed or CGO deps are missing (e.g.
# CI image without libx11-dev), we print a warning and exit 0 so the rest
# of the workspace build still completes. The runtime will surface a
# `runtime_constraint` error if CUA is requested without the helper.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKTREE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SIDECAR_DIR="$WORKTREE_ROOT/sidecars/cua"

if [[ ! -d "$SIDECAR_DIR" ]]; then
  echo "[build-cua-helper.sh] sidecars/cua not found — skipping"
  exit 0
fi

if ! command -v go >/dev/null 2>&1; then
  echo "[build-cua-helper.sh] Go toolchain not found — skipping (runtime CUA will be disabled)"
  exit 0
fi

cd "$SIDECAR_DIR"
if make cua-helper 2>&1; then
  echo "[build-cua-helper.sh] built $SIDECAR_DIR/synapse-device-cua-helper"
  exit 0
fi

echo "[build-cua-helper.sh] WARN: CUA helper build failed (likely missing CGO deps: libx11-dev libxtst-dev libxinerama-dev). Continuing without it; CUA tools will be unavailable until the binary is built."
exit 0
