#!/usr/bin/env bash
set -euo pipefail

# Build the synapse-device-cua-helper Go sidecar. Used by the root
# `npm run build:cua-helper` script so the binary is available next to the
# TypeScript runtime when a packaged release ships.
#
# Behavior:
#   - In dev (default): try to build. If Go isn't installed or CGO deps are
#     missing (e.g. CI without libx11-dev), set ALLOW_MISSING_CUA_HELPER=1
#     to skip with a warning. Otherwise, FAIL the build — a release that
#     ships without the helper has CUA silently disabled, which is a
#     security/UX regression worth catching loudly.
#
# Required CGO deps on Linux: libx11-dev libxtst-dev libxinerama-dev

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKTREE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SIDECAR_DIR="$WORKTREE_ROOT/sidecars/cua"

allow_missing="${ALLOW_MISSING_CUA_HELPER:-0}"

if [[ ! -d "$SIDECAR_DIR" ]]; then
  if [[ "$allow_missing" == "1" ]]; then
    echo "[build-cua-helper.sh] sidecars/cua not found — skipping (ALLOW_MISSING_CUA_HELPER=1)"
    exit 0
  fi
  echo "[build-cua-helper.sh] ERROR: sidecars/cua not found at $SIDECAR_DIR" >&2
  exit 1
fi

if ! command -v go >/dev/null 2>&1; then
  if [[ "$allow_missing" == "1" ]]; then
    echo "[build-cua-helper.sh] Go toolchain not found — skipping (ALLOW_MISSING_CUA_HELPER=1)"
    exit 0
  fi
  echo "[build-cua-helper.sh] ERROR: Go toolchain not found. Install Go 1.24+ or set ALLOW_MISSING_CUA_HELPER=1 (CUA tools will be unavailable)." >&2
  exit 1
fi

cd "$SIDECAR_DIR"
if make cua-helper 2>&1; then
  echo "[build-cua-helper.sh] built $SIDECAR_DIR/synapse-device-cua-helper"
  exit 0
fi

if [[ "$allow_missing" == "1" ]]; then
  echo "[build-cua-helper.sh] WARN: CUA helper build failed; continuing because ALLOW_MISSING_CUA_HELPER=1" >&2
  exit 0
fi

echo "[build-cua-helper.sh] ERROR: CUA helper build failed (likely missing CGO deps: libx11-dev libxtst-dev libxinerama-dev). Install the deps or set ALLOW_MISSING_CUA_HELPER=1 to skip." >&2
exit 1
