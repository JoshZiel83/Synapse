#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="/home/ubuntu/project/synapse"
PORT="${PORT:-3001}"

cd "$REPO_ROOT"

EXISTING_LISTENER="$(/usr/bin/ss -H -ltnp "sport = :$PORT" 2>/dev/null || true)"
if [[ -n "$EXISTING_LISTENER" ]]; then
  echo "Refusing to start Synapse API: port ${PORT} is already in use."
  echo "$EXISTING_LISTENER"
  exit 200
fi

exec /usr/bin/npm run start -w packages/api
