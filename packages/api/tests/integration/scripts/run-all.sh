#!/usr/bin/env bash
# Run every default integration test file SERIALLY through run-test.sh.
#
# Why one-file-per-invocation: every default test brings up its own isolated
# API process + resets this worktree's synapse_test database in its `before`
# hook. If they ran concurrently (which is what `node --test <multiple-files>`
# does by default — files run in worker pools), they would race on the
# `DROP DATABASE / CREATE DATABASE` and on this worktree's single API port. We
# saw that race: pg_database_datname unique-violation + EADDRINUSE. Serializing
# the file list here means each file owns the DB and the API port for its full
# lifetime.
#
# NOTE: the DB / API ports are now derived PER WORKTREE by scripts/lib.sh (no
# longer the hardcoded 55433/38091), so different worktrees no longer collide —
# but within one worktree the stack is still shared, hence the serialization.
#
# This script only loops the test files; bringing the stack up and tearing it
# down is owned by run-integration.sh (the `test:integration` entrypoint). Run
# this directly only if you've already `up.sh`'d the stack yourself.
#
# The `manual/` subdir is intentionally NOT in the default glob — those
# tests reach externally configured services and are opt-in via separate
# npm scripts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTEGRATION_DIR="$(dirname "$SCRIPT_DIR")"

shopt -s nullglob
TEST_FILES=("$INTEGRATION_DIR"/*.test.ts)
shopt -u nullglob

if [[ "${#TEST_FILES[@]}" -eq 0 ]]; then
  echo "[run-all.sh] No *.test.ts files in $INTEGRATION_DIR — nothing to do." >&2
  exit 0
fi

failures=()
for test_file in "${TEST_FILES[@]}"; do
  rel="${test_file#"$INTEGRATION_DIR"/}"
  echo
  echo "================================================================"
  echo "[run-all.sh] $rel"
  echo "================================================================"
  if ! bash "$SCRIPT_DIR/run-test.sh" "$test_file"; then
    failures+=("$rel")
  fi
done

echo
echo "================================================================"
if [[ "${#failures[@]}" -gt 0 ]]; then
  echo "[run-all.sh] ${#failures[@]} integration test file(s) failed:"
  for f in "${failures[@]}"; do
    echo "  - $f"
  done
  exit 1
fi
echo "[run-all.sh] all ${#TEST_FILES[@]} integration test file(s) passed."
