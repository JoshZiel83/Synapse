#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="/home/ubuntu/project/synapse"
WEB_DIR="$REPO_ROOT/packages/web-next"

cd "$WEB_DIR"

exec /usr/bin/npm run dev -- --hostname 0.0.0.0 --port 3000
