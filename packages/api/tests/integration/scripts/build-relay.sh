#!/usr/bin/env bash
set -euo pipefail

# Build the synapse-relay CLI binary used by integration tests.
# Caches under packages/api/tests/integration/.cache/synapse-relay.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTEGRATION_DIR="$(dirname "$SCRIPT_DIR")"
CACHE_DIR="$INTEGRATION_DIR/.cache"
CACHED_BIN="$CACHE_DIR/synapse-relay"

# Resolve worktree root (six levels up from scripts/)
WORKTREE_ROOT="$(cd "$INTEGRATION_DIR/../../../.." && pwd)"
RELAY_DIR="$WORKTREE_ROOT/relay"
RELAY_BIN="$RELAY_DIR/synapse-relay"

if [[ ! -d "$RELAY_DIR" ]]; then
  echo "[build-relay.sh] Relay source not found at $RELAY_DIR"
  exit 1
fi

if ! command -v go >/dev/null 2>&1; then
  echo "[build-relay.sh] Go toolchain not found. Install Go 1.24+."
  exit 1
fi

# Check whether cached binary is stale.
needs_rebuild=1
if [[ -x "$CACHED_BIN" ]]; then
  needs_rebuild=0
  cached_mtime=$(stat -c %Y "$CACHED_BIN")
  while IFS= read -r src; do
    src_mtime=$(stat -c %Y "$src")
    if [[ "$src_mtime" -gt "$cached_mtime" ]]; then
      needs_rebuild=1
      break
    fi
  done < <(find "$RELAY_DIR/cmd" "$RELAY_DIR/internal" \
    "$RELAY_DIR/go.mod" "$RELAY_DIR/go.sum" \
    -type f 2>/dev/null)
fi

if [[ "$needs_rebuild" -eq 0 ]]; then
  echo "[build-relay.sh] Cached binary is up to date: $CACHED_BIN"
  "$CACHED_BIN" --version || true
  exit 0
fi

echo "[build-relay.sh] Building relay CLI (cd $RELAY_DIR && make cli)..."
(cd "$RELAY_DIR" && make cli)

mkdir -p "$CACHE_DIR"
cp "$RELAY_BIN" "$CACHED_BIN"
chmod +x "$CACHED_BIN"

echo "[build-relay.sh] Cached at $CACHED_BIN"
"$CACHED_BIN" --version || true
