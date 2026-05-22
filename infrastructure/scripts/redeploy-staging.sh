#!/usr/bin/env bash
# Build + start (or restart) THIS worktree's staging stack, then bootstrap +
# seed the staging database, then run the smoke integration test.
#
# Idempotent: re-runs apply schema migrations and re-seed without dropping
# data (bootstrap checks state). Pass --reset to drop + recreate the DB volume.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

# shellcheck disable=SC1091
source "${SCRIPT_DIR}/staging-env.sh"

RESET=false
SKIP_SMOKE=false
SKIP_SEED=false
for arg in "$@"; do
  case "$arg" in
    --reset) RESET=true ;;
    --skip-smoke) SKIP_SMOKE=true ;;
    --skip-seed) SKIP_SEED=true ;;
    *)
      echo "unknown arg: $arg" >&2
      echo "usage: $0 [--reset] [--skip-smoke] [--skip-seed]" >&2
      exit 1
      ;;
  esac
done

COMPOSE="docker compose -f ${SYNAPSE_STAGING_COMPOSE_FILE} --profile staging"

if [[ "${RESET}" == "true" ]]; then
  echo "[redeploy] --reset: tearing down volumes ..."
  ${COMPOSE} down -v --remove-orphans || true
fi

echo "[redeploy] building images ..."
${COMPOSE} build api web mobile-web

echo "[redeploy] starting infrastructure (postgres, redis, socks-bridge) ..."
${COMPOSE} up -d postgres redis socks-bridge

echo "[redeploy] waiting for postgres healthy ..."
for _ in {1..30}; do
  if docker inspect --format '{{.State.Health.Status}}' \
      "synapse-postgres-stg-${SYNAPSE_STAGING_SLUG}" 2>/dev/null | grep -q healthy; then
    break
  fi
  sleep 2
done

echo "[redeploy] running schema bootstrap (idempotent) ..."
docker run --rm \
  --network "synapse-stg-${SYNAPSE_STAGING_SLUG}_default" \
  -e DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}" \
  -e REDIS_URL="redis://:${REDIS_PASSWORD}@redis:6379" \
  "synapse-api-stg:${SYNAPSE_STAGING_SLUG}" \
  node /app/packages/api/dist/infrastructure/database/bootstrap.js

if [[ "${SKIP_SEED}" != "true" ]]; then
  echo "[redeploy] seeding official actor templates + builtin marketplaces ..."
  docker run --rm \
    --network "synapse-stg-${SYNAPSE_STAGING_SLUG}_default" \
    -e DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}" \
    -e REDIS_URL="redis://:${REDIS_PASSWORD}@redis:6379" \
    -e PLATFORM_ADMIN_EMAILS="${PLATFORM_ADMIN_EMAILS}" \
    "synapse-api-stg:${SYNAPSE_STAGING_SLUG}" \
    node /app/packages/api/dist/infrastructure/database/seed.js || {
      echo "[redeploy] WARN: seed had non-fatal errors (typically missing builtin plugin icons)"
    }
fi

echo "[redeploy] starting application services (api, web, mobile-web, nginx-http) ..."
${COMPOSE} up -d

echo "[redeploy] waiting for api health ..."
for i in {1..60}; do
  if curl -fsS "http://127.0.0.1:${NGINX_PORT}/api/v1/health" >/dev/null 2>&1; then
    echo "[redeploy] api is up at http://127.0.0.1:${NGINX_PORT}/api/v1/health"
    break
  fi
  if [[ $i -eq 60 ]]; then
    echo "[redeploy] ERROR: api never became healthy in 120s" >&2
    docker logs --tail 50 "synapse-api-stg-${SYNAPSE_STAGING_SLUG}" >&2 || true
    exit 1
  fi
  sleep 2
done

if [[ "${SKIP_SMOKE}" != "true" ]]; then
  echo "[redeploy] running smoke integration tests ..."
  STAGING_API_URL="http://127.0.0.1:${NGINX_PORT}/api/v1" \
    npx tsx --test packages/api/test/integration/smoke.test.ts
fi

echo ""
echo "[redeploy] DONE"
echo "[redeploy] desktop: http://127.0.0.1:${NGINX_PORT}/"
echo "[redeploy] mobile:  http://127.0.0.1:${NGINX_PORT}/mobile/"
echo "[redeploy] api:     http://127.0.0.1:${NGINX_PORT}/api/v1/health"
