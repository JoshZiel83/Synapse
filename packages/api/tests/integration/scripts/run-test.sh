#!/usr/bin/env bash
set -euo pipefail

# Runs an integration test file with the worktree-isolated test stack env vars
# pre-set. Required because Node ESM hoists static `import` statements before
# any top-of-file `process.env = ...` assignments — so importing API modules
# that read env at module-load time (config/index.ts, redis client, pg pool)
# need the env vars set in the parent process, not the test file body.
#
# DB/Redis/API connection env is derived per-worktree by lib.sh and set here
# UNCONDITIONALLY (not `${VAR:-...}`): an inherited DATABASE_URL pointing at a
# real deployment must never leak into the test run.
#
# Usage:
#   bash packages/api/tests/integration/scripts/run-test.sh \
#     packages/api/tests/integration/origin-propagation.test.ts
#
# Pass extra files / globs as additional positional args.

if [[ "$#" -lt 1 ]]; then
  echo "Usage: $0 <test-file-or-glob> [more...]" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh" run

# Unconditional — derived per-worktree, overrides any inherited value.
export DATABASE_URL="postgresql://synapse:test_password@127.0.0.1:${INT_PG_PORT}/synapse_test"
export REDIS_URL="redis://127.0.0.1:${INT_REDIS_PORT}"
export BASE_URL="http://127.0.0.1:${INT_API_PORT}"
# Sentinel proving the test was launched through this wrapper — gates the
# per-file run guards AND the destructive resetDb() in harness/db.ts.
export SYNAPSE_INT_TEST=1

export NODE_ENV="${NODE_ENV:-test}"
# Per-worktree storage dir keyed on the FULL project name (which embeds the path
# hash), not the truncated slug — two worktrees whose basenames share the first
# 20 normalized chars must not collide on / delete each other's storage.
# Teardown of this dir is owned by down.sh (covers both the owning wrapper and
# manual up.sh + run-test.sh + down.sh flows).
export STORAGE_DIR="${STORAGE_DIR:-/tmp/${INT_PROJECT_NAME}-storage}"
mkdir -p "$STORAGE_DIR"
export JWT_SECRET="${JWT_SECRET:-int_test_jwt_secret}"
export JWT_REFRESH_SECRET="${JWT_REFRESH_SECRET:-int_test_jwt_refresh_secret}"

# Some module-load-time code may also try to connect at import time; isolate
# memory-model bootstrap so it doesn't fetch.
export MEMORY_ALLOW_RUNTIME_MODEL_DOWNLOAD="${MEMORY_ALLOW_RUNTIME_MODEL_DOWNLOAD:-false}"

exec node --test --test-reporter=spec --import tsx "$@"
