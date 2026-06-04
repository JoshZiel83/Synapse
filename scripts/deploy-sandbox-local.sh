#!/usr/bin/env bash
set -euo pipefail

# Deploy the containerized-LOCAL actor sandbox: the device-runtime runs as a
# same-host child of the API container, confined by bwrap. This is the
# single-tenant / trusted alternative to the docker backend; see deploy.md §8b.1.
#
# WARNING: the local override grants the API container SYS_ADMIN + NET_ADMIN +
# seccomp/apparmor unconfined (every process in it). Use only on an isolated /
# trusted single-tenant host; prefer the docker backend otherwise.
#
# What it does:
#   1. Fail-fast if .env is missing its deploy baseline (POSTGRES_PASSWORD,
#      REDIS_PASSWORD, APP_BASE_URL, BASE_URL).
#   2. Reject conflicting shell-env overrides of the managed sandbox flags
#      (compose reads the shell BEFORE .env, so a stray export would silently win).
#   3. Ensure the two sandbox secrets exist (scripts/ensure-sandbox-secrets.sh).
#   4. Switch the sandbox mode flags in .env (ENABLED=true, BACKEND=local).
#   5. Build the api image, then run the bwrap smoke test in a THROWAWAY
#      container — BEFORE bringing the real stack up, so a cap-stack failure never
#      leaves a running local+privileged API behind.
#   6. Bring up api + tunnel-edge WITH the local override.
#
# Failure handling: .env is backed up (OUTSIDE the repo, so the secret-bearing
# copy never enters a docker build context) and restored on any failure /
# interruption. Because the smoke runs before `up`, a failure up to that point
# also means nothing was started — no privileged container is left running.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"
ENV_FILE="$REPO_ROOT/.env"
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.sandbox-local.yml --profile production)

log() { echo "[deploy-sandbox-local] $*" >&2; }
die() { echo "[deploy-sandbox-local] ERROR: $*" >&2; exit 1; }
trim() { printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }
# shellcheck source=lib-sandbox-deploy.sh
. "$SCRIPT_DIR/lib-sandbox-deploy.sh"

# 1. Baseline .env fail-fast.
[ -f "$ENV_FILE" ] || die ".env not found — run ./setup.sh first."
for required in POSTGRES_PASSWORD REDIS_PASSWORD APP_BASE_URL BASE_URL; do
  val="$(trim "$(sed -n "s/^$required=//p" "$ENV_FILE" | tail -n 1)")"
  [ -n "$val" ] || die "$required missing/empty in .env — run ./setup.sh first (it generates the deploy baseline)."
done

# 2. Reject conflicting shell env (raw-exact — a set-empty shell var makes compose
#    use the default, ignoring .env). A shell loopback origin is fine for local
#    (the override sets it anyway), so origin is left unconstrained here.
assert_shell_flag SYNAPSE_SANDBOX_ENABLED true
assert_shell_flag SYNAPSE_SANDBOX_BACKEND local

# Snapshot how api + tunnel-edge exist BEFORE we touch anything, so a failed
# deploy can restore each to its exact pre-deploy state (absent / stopped /
# running, and the api's override form).
PREDEPLOY_API_SNAPSHOT="$(predeploy_api_snapshot)"
PREDEPLOY_TUNNEL_SNAPSHOT="$(predeploy_tunnel_snapshot)"

# Back up .env to a path GUARANTEED outside the repo, so the secret-bearing copy
# can never enter a docker build context. We don't trust $TMPDIR (a caller could
# point it inside the tree): prefer /tmp, and hard-fail if the resolved backup
# path is under the repo. (.dockerignore also excludes synapse-env-predeploy.* as
# a second layer.)
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
    # Roll api FIRST (depends on nothing), then tunnel-edge. Each restores its
    # exact pre-deploy snapshot; rollback_* unset managed vars so compose honors
    # the restored .env, not a shell flag we accepted for THIS deploy.
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

# 3. Ensure sandbox secrets (signing key + frp token).
bash "$SCRIPT_DIR/ensure-sandbox-secrets.sh"

# 3b. Reject empty/conflicting shell secrets (raw-exact: tunnel-edge gets the
#     token verbatim while the API trims it, so a padded shell token breaks frp
#     auth; a set-empty one blanks the secret via the compose default).
assert_shell_secret FRP_SHARED_TOKEN
assert_shell_secret SYNAPSE_DEVICE_ENVELOPE_SIGNING_KEY

# 4. Switch ONLY the mode flags (idempotent in-place upsert). Deliberately NOT
#    SYNAPSE_SANDBOX_SERVER_ORIGIN — that loopback lives in the override only.
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
upsert SYNAPSE_SANDBOX_BACKEND local
log "set SYNAPSE_SANDBOX_ENABLED=true, SYNAPSE_SANDBOX_BACKEND=local"

# 5. Build, then smoke in a THROWAWAY container BEFORE `up`. If the cap stack is
#    insufficient the smoke fails here and we never started a privileged API.
log "building api image (baked fs-helper + bubblewrap + ripgrep)..."
"${COMPOSE[@]}" build api
log "running bwrap exec smoke test (throwaway container, before bring-up)..."
bash "$SCRIPT_DIR/sandbox-local-smoke.sh"

# 6. Bring up the real stack. tunnel-edge FIRST (benign, no special caps), so a
#    failure there never started the privileged API. Build tunnel-edge too (a
#    stale local image won't be rebuilt by `up` otherwise). The API goes last and
#    is flagged so the cleanup trap can roll it back on a bring-up failure.
log "starting tunnel-edge..."
"${COMPOSE[@]}" build tunnel-edge
TUNNEL_STARTED=1
"${COMPOSE[@]}" up -d tunnel-edge
log "starting api with the local override (SYS_ADMIN/NET_ADMIN)..."
API_STARTED=1
"${COMPOSE[@]}" up -d api

SUCCESS=1
log "done. Verify a real turn: send a message, then watch:"
log "  docker compose logs -f api | grep -i sandbox"
