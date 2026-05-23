#!/usr/bin/env bash
set -euo pipefail

# Runs an integration test file with the worktree-isolated test stack env vars
# pre-set. Required because Node ESM hoists static `import` statements before
# any top-of-file `process.env = ...` assignments — so importing API modules
# that read env at module-load time (config/index.ts, redis client, pg pool)
# need the env vars set in the parent process, not the test file body.
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

export DATABASE_URL="${DATABASE_URL:-postgresql://synapse:test_password@127.0.0.1:55433/synapse_test}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:56380}"
export NODE_ENV="${NODE_ENV:-test}"
export STORAGE_DIR="${STORAGE_DIR:-/tmp/synapse-int-runtest-storage}"
export JWT_SECRET="${JWT_SECRET:-int_test_jwt_secret}"
export JWT_REFRESH_SECRET="${JWT_REFRESH_SECRET:-int_test_jwt_refresh_secret}"
export BASE_URL="${BASE_URL:-http://127.0.0.1:38091}"

# Some module-load-time code may also try to connect at import time; isolate
# memory-model bootstrap so it doesn't fetch.
export MEMORY_ALLOW_RUNTIME_MODEL_DOWNLOAD="${MEMORY_ALLOW_RUNTIME_MODEL_DOWNLOAD:-false}"

exec node --test --test-reporter=spec --import tsx "$@"
