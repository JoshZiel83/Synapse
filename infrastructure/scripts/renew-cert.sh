#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

docker compose --profile certbot run --rm certbot renew \
  --webroot \
  --webroot-path /var/www/certbot

docker compose --profile production exec -T nginx nginx -s reload >/dev/null 2>&1 || true
