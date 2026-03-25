#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="/home/ubuntu/project/synapse"

cd "$REPO_ROOT"

exec /usr/bin/npm run start -w packages/api
