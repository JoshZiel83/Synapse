#!/usr/bin/env bash
set -euo pipefail

# Owning wrapper for the default integration suite (`npm run test:integration`).
#
# Owns the full lifecycle so the default entrypoint leaves NOTHING behind:
#   up.sh  ->  run-all.sh  ->  down.sh
# The cleanup trap is installed BEFORE up.sh (so a partial/half-created stack
# from a failed `up --wait` is still torn down) and is non-reentrant (it
# detaches itself first, otherwise the `exit` inside an INT/TERM handler would
# re-trigger the EXIT trap and run cleanup twice). The original exit code is
# preserved.
#
#   KEEP_CONTAINERS=1  skip auto-teardown — leave the stack up for debugging.
#                      Use as a one-shot prefix (KEEP_CONTAINERS=1 npm run ...);
#                      if you `export` it, remember to `unset` before `down.sh`,
#                      which also honors KEEP_CONTAINERS and would otherwise no-op.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh" up

KEEP="${KEEP_CONTAINERS:-0}"

cleanup() {
  rc=$?
  trap - EXIT INT TERM           # detach first → non-reentrant
  bash "$SCRIPT_DIR/down.sh" || true   # down.sh also removes the per-worktree storage dir
  exit "$rc"
}

if [[ "$KEEP" != "1" ]]; then
  trap cleanup EXIT INT TERM     # installed BEFORE up so partial bring-up is reaped
fi

bash "$SCRIPT_DIR/up.sh"          # set -e: failure here triggers cleanup, skips run-all
bash "$SCRIPT_DIR/run-all.sh"
