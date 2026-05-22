#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
fi

if [ "${SYNAPSE_DEPLOY_MODE:-tls}" = "http" ]; then
  echo "SYNAPSE_DEPLOY_MODE=http does not use Let's Encrypt certificates; skipping renewal."
  exit 0
fi

docker compose --profile certbot run --rm certbot renew \
  --webroot \
  --webroot-path /var/www/certbot

docker compose --profile production --profile tls exec -T nginx nginx -s reload >/dev/null 2>&1 || true
