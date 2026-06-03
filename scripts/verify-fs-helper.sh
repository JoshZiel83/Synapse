#!/usr/bin/env bash
set -euo pipefail

# One-shot verification of the synapse-device-fs-helper sidecar end to end:
# builds the shipping (release) binary, runs the Rust tests (incl. the fs.hello
# handshake), then the TS suites that exercise the binary. Meant to be called by
# a CI runner or by hand — this repo uses scripted "non-GitHub CI" rather than
# .github/workflows.
#
# Env knobs:
#   ALLOW_MISSING_FS_HELPER=1  passthrough to the release build (degrade to a
#                              warning instead of failing when Rust is absent).
#   SYNAPSE_VERIFY_SKIP_API=1  skip the api suites (they need Postgres +
#                              testcontainers; handy for a quick local pass).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SIDECAR_DIR="$REPO_ROOT/sidecars/fs-helper"

cd "$REPO_ROOT"

echo "==> [1/5] pretest-fs-helper.sh self-tests"
bash scripts/pretest-fs-helper.test.sh

echo "==> [2/5] build release sidecar (fail-loud)"
bash scripts/build-fs-helper.sh

echo "==> [3/5] cargo build (debug) + cargo test"
if command -v cargo >/dev/null 2>&1; then
  (cd "$SIDECAR_DIR" && cargo build && cargo test)
elif [[ "${ALLOW_MISSING_FS_HELPER:-0}" == "1" ]]; then
  echo "    cargo not found — skipping (ALLOW_MISSING_FS_HELPER=1)"
else
  echo "    ERROR: cargo not found. Install Rust or set ALLOW_MISSING_FS_HELPER=1." >&2
  exit 1
fi

echo "==> [4/5] device-runtime test suite"
npm run test -w packages/device-runtime

if [[ "${SYNAPSE_VERIFY_SKIP_API:-0}" == "1" ]]; then
  echo "==> [5/5] api suites SKIPPED (SYNAPSE_VERIFY_SKIP_API=1)"
else
  echo "==> [5/5] api test suite (needs Postgres + testcontainers)"
  npm run test -w packages/api
fi

echo "==> fs-helper verify OK"
