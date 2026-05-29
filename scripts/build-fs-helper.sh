#!/usr/bin/env bash
set -euo pipefail

# Build the synapse-device-fs-helper Rust sidecar. Used by the root
# `npm run build:fs-helper` script so the binary is available next to the
# TypeScript runtime when a packaged release ships.
#
# Behavior:
#   - In dev (default): try to build. If Rust isn't installed (no `cargo`),
#     set ALLOW_MISSING_FS_HELPER=1 to skip with a warning. Otherwise FAIL
#     loudly — a release that ships without the helper silently disables
#     history / indexed search / extract.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKTREE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SIDECAR_DIR="$WORKTREE_ROOT/sidecars/fs-helper"

allow_missing="${ALLOW_MISSING_FS_HELPER:-0}"

if [[ ! -d "$SIDECAR_DIR" ]]; then
  if [[ "$allow_missing" == "1" ]]; then
    echo "[build-fs-helper.sh] sidecars/fs-helper not found — skipping (ALLOW_MISSING_FS_HELPER=1)"
    exit 0
  fi
  echo "[build-fs-helper.sh] ERROR: sidecars/fs-helper not found at $SIDECAR_DIR" >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  if [[ "$allow_missing" == "1" ]]; then
    echo "[build-fs-helper.sh] cargo not found — skipping (ALLOW_MISSING_FS_HELPER=1)"
    exit 0
  fi
  echo "[build-fs-helper.sh] ERROR: cargo not found. Install Rust 1.70+ or set ALLOW_MISSING_FS_HELPER=1 (fs-helper features will be unavailable)." >&2
  exit 1
fi

cd "$SIDECAR_DIR"
if cargo build --release 2>&1; then
  echo "[build-fs-helper.sh] built $SIDECAR_DIR/target/release/synapse-device-fs-helper"
  exit 0
fi

if [[ "$allow_missing" == "1" ]]; then
  echo "[build-fs-helper.sh] WARN: fs-helper build failed; continuing because ALLOW_MISSING_FS_HELPER=1" >&2
  exit 0
fi

echo "[build-fs-helper.sh] ERROR: fs-helper build failed. Inspect cargo output above or set ALLOW_MISSING_FS_HELPER=1 to skip." >&2
exit 1
