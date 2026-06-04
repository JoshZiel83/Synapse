#!/usr/bin/env bash
set -euo pipefail

# Deploy the DOCKER actor sandbox backend: each session's device-runtime runs in
# its own cloud-sandbox container (DooD via the host docker socket), reached over
# the frp tunnel. This is the multi-tenant / production-recommended backend; see
# deploy.md §8b.
#
# What it does:
#   1. Fail-fast if .env is missing its deploy baseline (POSTGRES_PASSWORD,
#      REDIS_PASSWORD, APP_BASE_URL, BASE_URL).
#   2. Ensure the two sandbox secrets exist (signing key + frp token) — the
#      docker backend fail-fasts at provision without FRP_SHARED_TOKEN.
#   3. Switch the mode flags in .env (ENABLED=true, BACKEND=docker, TUNNEL=frp).
#   4. Guard the EFFECTIVE SYNAPSE_SANDBOX_SERVER_ORIGIN: the docker sandbox is on
#      an internal-only network, so the origin must be UNSET (compose default
#      http://api:3001) or exactly that internal address — never a loopback (the
#      container would dial itself) or a public domain (no egress). Compose reads
#      the SHELL env before .env, so we check the shell value too, and strip a
#      stale loopback left in .env by a prior local-backend run.
#   5. Build api (baked fs-helper) + the cloud-sandbox image + tunnel-edge, then
#      bring up api + tunnel-edge WITH the docker-socket override.
#
# Failure handling: .env is backed up before any edit and restored on failure /
# interruption, so a half-switched env is never left behind.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"
ENV_FILE="$REPO_ROOT/.env"
INTERNAL_ORIGIN="http://api:3001"

log() { echo "[deploy-sandbox-docker] $*" >&2; }
die() { echo "[deploy-sandbox-docker] ERROR: $*" >&2; exit 1; }
trim() { printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }

# 1. Baseline .env fail-fast.
[ -f "$ENV_FILE" ] || die ".env not found — run ./setup.sh first."
for required in POSTGRES_PASSWORD REDIS_PASSWORD APP_BASE_URL BASE_URL; do
  val="$(trim "$(sed -n "s/^$required=//p" "$ENV_FILE" | tail -n 1)")"
  [ -n "$val" ] || die "$required missing/empty in .env — run ./setup.sh first."
done

# Back up .env; restore on any failure unless we mark success.
ENV_BACKUP="$(mktemp "${ENV_FILE}.predeploy.XXXXXX")"
cp -p "$ENV_FILE" "$ENV_BACKUP"
SUCCESS=0
cleanup() {
  if [ "$SUCCESS" -ne 1 ] && [ -f "$ENV_BACKUP" ]; then
    cp -p "$ENV_BACKUP" "$ENV_FILE"
    log "deploy failed — restored the original .env (sandbox flags reverted)."
    log "the running stack was NOT modified by the rollback; re-check 'docker compose ps'."
  fi
  rm -f "$ENV_BACKUP"
}
trap cleanup EXIT

# 2. Ensure sandbox secrets.
bash "$SCRIPT_DIR/ensure-sandbox-secrets.sh"

# 3. Switch the three mode flags (idempotent in-place upsert).
upsert() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i -E "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    if [ -n "$(tail -c1 "$ENV_FILE")" ]; then printf '\n' >>"$ENV_FILE"; fi
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
}
upsert SYNAPSE_SANDBOX_ENABLED true
upsert SYNAPSE_SANDBOX_BACKEND docker
upsert SYNAPSE_SANDBOX_TUNNEL frp
log "set SYNAPSE_SANDBOX_ENABLED=true, SYNAPSE_SANDBOX_BACKEND=docker, SYNAPSE_SANDBOX_TUNNEL=frp"

# 4. EFFECTIVE-origin guard. A stale loopback in .env (from a prior local run)
#    is silently removed (compose default is the right internal address); a
#    custom non-internal value — in .env OR the shell — is a hard error.
env_origin="$(trim "$(sed -n 's/^SYNAPSE_SANDBOX_SERVER_ORIGIN=//p' "$ENV_FILE" | tail -n 1)")"
case "$env_origin" in
  *127.0.0.1*|*localhost*|*"[::1]"*)
    sed -i -E '/^SYNAPSE_SANDBOX_SERVER_ORIGIN=/d' "$ENV_FILE"
    log "removed a stale loopback SYNAPSE_SANDBOX_SERVER_ORIGIN from .env (docker uses ${INTERNAL_ORIGIN})."
    env_origin=""
    ;;
esac
[ -z "$env_origin" ] || [ "$env_origin" = "$INTERNAL_ORIGIN" ] || \
  die "SYNAPSE_SANDBOX_SERVER_ORIGIN in .env is '${env_origin}'; for the docker backend it must be unset or '${INTERNAL_ORIGIN}' (internal-only network)."
# Compose reads the shell env BEFORE .env, so a shell export overrides .env.
shell_origin="$(trim "${SYNAPSE_SANDBOX_SERVER_ORIGIN:-}")"
if [ -n "$shell_origin" ] && [ "$shell_origin" != "$INTERNAL_ORIGIN" ]; then
  die "shell env SYNAPSE_SANDBOX_SERVER_ORIGIN='${shell_origin}' would override .env (compose precedence); unset it or set it to '${INTERNAL_ORIGIN}' before deploying."
fi
log "effective SYNAPSE_SANDBOX_SERVER_ORIGIN OK (unset → compose default ${INTERNAL_ORIGIN}, or explicitly ${INTERNAL_ORIGIN})."

# 5. Build images, then bring up with the docker-socket override.
log "building api image (baked fs-helper)..."
docker compose --profile production build api
log "building cloud-sandbox image (synapse-device-runtime:latest)..."
docker compose --profile sandbox-build build sandbox-image
log "starting api + tunnel-edge with the docker-backend override..."
docker compose -f docker-compose.yml -f docker-compose.sandbox-docker.yml \
  --profile production up -d api tunnel-edge

SUCCESS=1
log "done. Verify the docker backend is dispatchable:"
log "  docker compose exec api docker image inspect synapse-device-runtime:latest >/dev/null && echo image-ok"
log "  docker compose logs -f api | grep -i sandbox   # then trigger a turn → a synapse-sbx-* container appears"
