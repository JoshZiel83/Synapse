#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="/home/ubuntu/project/synapse"

cd "$REPO_ROOT"

exec /usr/bin/npm run dev -w packages/web-next -- --hostname 127.0.0.1 --port 3002
