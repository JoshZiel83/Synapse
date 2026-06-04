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
#   5. Build all three images (api + cloud-sandbox + tunnel-edge), then bring up
#      api + tunnel-edge WITH the docker-socket override.
#
# Failure handling: .env is backed up OUTSIDE the repo (so the secret-bearing copy
# never enters a docker build context) and restored on failure / interruption, so
# a half-switched env is never left behind.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"
ENV_FILE="$REPO_ROOT/.env"
INTERNAL_ORIGIN="http://api:3001"

log() { echo "[deploy-sandbox-docker] $*" >&2; }
die() { echo "[deploy-sandbox-docker] ERROR: $*" >&2; exit 1; }
trim() { printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }
# shellcheck source=lib-sandbox-deploy.sh
. "$SCRIPT_DIR/lib-sandbox-deploy.sh"

# 1. Baseline .env fail-fast.
[ -f "$ENV_FILE" ] || die ".env not found — run ./setup.sh first."
for required in POSTGRES_PASSWORD REDIS_PASSWORD APP_BASE_URL BASE_URL; do
  val="$(trim "$(sed -n "s/^$required=//p" "$ENV_FILE" | tail -n 1)")"
  [ -n "$val" ] || die "$required missing/empty in .env — run ./setup.sh first."
done

# 1b. Reject conflicting shell env for the managed flags (raw-exact — a set-empty
#     shell var makes compose use the default, ignoring .env). Origin handled in #4.
assert_shell_flag SYNAPSE_SANDBOX_ENABLED true
assert_shell_flag SYNAPSE_SANDBOX_BACKEND docker
assert_shell_flag SYNAPSE_SANDBOX_TUNNEL frp

# Snapshot how api + tunnel-edge exist BEFORE we touch anything, so a failed
# deploy can restore each to its exact pre-deploy state (absent / stopped /
# running, and the api's override form).
PREDEPLOY_API_SNAPSHOT="$(predeploy_api_snapshot)"
PREDEPLOY_TUNNEL_SNAPSHOT="$(predeploy_tunnel_snapshot)"

# Back up .env to a path GUARANTEED outside the repo (don't trust $TMPDIR — a
# caller could point it inside the tree, leaking the secret-bearing copy into a
# build context). Prefer /tmp; hard-fail if the resolved path is under the repo.
# (.dockerignore also excludes synapse-env-predeploy.* as a second layer.)
BACKUP_DIR="/tmp"
[ -d "$BACKUP_DIR" ] && [ -w "$BACKUP_DIR" ] || BACKUP_DIR="${TMPDIR:-/tmp}"
ENV_BACKUP="$(mktemp "${BACKUP_DIR%/}/synapse-env-predeploy.XXXXXX")"
case "$(realpath "$ENV_BACKUP")" in
  "$REPO_ROOT"/*) die "refusing to back up .env inside the repo ($ENV_BACKUP); set TMPDIR to a path outside $REPO_ROOT." ;;
esac
cp -p "$ENV_FILE" "$ENV_BACKUP"

# Track which services we (re)started this run, so a FINAL bring-up failure rolls
# each back to its pre-deploy snapshot. Set to 1 right before each `up`.
API_STARTED=0
TUNNEL_STARTED=0
SUCCESS=0
cleanup() {
  if [ "$SUCCESS" -ne 1 ]; then
    if [ -f "$ENV_BACKUP" ]; then
      cp -p "$ENV_BACKUP" "$ENV_FILE"
      log "deploy failed — restored the original .env (sandbox flags reverted)."
    fi
    # Each rollback restores its exact pre-deploy snapshot; rollback_* unset
    # managed vars so compose honors the restored .env, not a shell flag we
    # accepted for THIS deploy.
    if [ "$API_STARTED" -eq 1 ]; then
      rollback_api "$PREDEPLOY_API_SNAPSHOT" \
        || log "WARNING: could not auto-roll-back the API container — check 'docker compose ps' and re-run with the restored .env."
    fi
    if [ "$TUNNEL_STARTED" -eq 1 ]; then
      rollback_tunnel "$PREDEPLOY_TUNNEL_SNAPSHOT" \
        || log "WARNING: could not auto-roll-back tunnel-edge — check 'docker compose ps'."
    fi
  fi
  rm -f "$ENV_BACKUP"
}
trap cleanup EXIT

# 2. Ensure sandbox secrets.
bash "$SCRIPT_DIR/ensure-sandbox-secrets.sh"

# 2b. Reject empty/conflicting shell secrets (raw-exact). FRP_SHARED_TOKEN +
#     SYNAPSE_DEVICE_ENVELOPE_SIGNING_KEY are ${...:-} in compose (shell wins over
#     .env); a set-empty one blanks the secret (docker backend fail-fasts without
#     a token), and a padded one breaks frp auth (tunnel-edge gets it verbatim,
#     the API trims it).
assert_shell_secret FRP_SHARED_TOKEN
assert_shell_secret SYNAPSE_DEVICE_ENVELOPE_SIGNING_KEY

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

# 5. Build images, then bring up. tunnel-edge FIRST (no docker-socket), then the
#    API last with the override, flagged so a bring-up failure rolls it back.
log "building api image (baked fs-helper)..."
docker compose --profile production build api
log "building cloud-sandbox image (synapse-device-runtime:latest)..."
docker compose --profile sandbox-build build sandbox-image
log "building tunnel-edge (frps) image..."
docker compose -f docker-compose.yml -f docker-compose.sandbox-docker.yml \
  --profile production build tunnel-edge
log "starting tunnel-edge..."
TUNNEL_STARTED=1
docker compose -f docker-compose.yml -f docker-compose.sandbox-docker.yml \
  --profile production up -d tunnel-edge
log "starting api with the docker-socket override..."
API_STARTED=1
docker compose -f docker-compose.yml -f docker-compose.sandbox-docker.yml \
  --profile production up -d api

SUCCESS=1
log "done. Verify the docker backend is dispatchable:"
log "  docker compose exec api docker image inspect synapse-device-runtime:latest >/dev/null && echo image-ok"
log "  docker compose logs -f api | grep -i sandbox   # then trigger a turn → a synapse-sbx-* container appears"
