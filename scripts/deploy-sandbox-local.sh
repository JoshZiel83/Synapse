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
#      REDIS_PASSWORD, APP_BASE_URL, BASE_URL) — those come from ./setup.sh and
#      the compose api service hard-requires them.
#   2. Ensure the two sandbox secrets exist (scripts/ensure-sandbox-secrets.sh).
#   3. Switch the sandbox mode flags in .env (ENABLED=true, BACKEND=local).
#      NB: the loopback SYNAPSE_SANDBOX_SERVER_ORIGIN is injected by the
#      docker-compose.sandbox-local.yml override, NOT written to .env (it is
#      shared with the docker backend).
#   4. Build the api image (baked fs-helper + bubblewrap + ripgrep) and bring up
#      api + tunnel-edge WITH the local override (cap_add SYS_ADMIN/NET_ADMIN +
#      seccomp/apparmor unconfined).
#   5. Run the bwrap exec smoke test.
#
# Failure handling: .env is backed up before any edit. If build / up / smoke
# fails (or the script is interrupted), the ORIGINAL .env is restored so the
# deployment is never left half-switched into a local+privileged state, and the
# running stack (if any) is whatever it was before. On success the new .env is
# kept and the backup removed.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"
ENV_FILE="$REPO_ROOT/.env"

log() { echo "[deploy-sandbox-local] $*" >&2; }
die() { echo "[deploy-sandbox-local] ERROR: $*" >&2; exit 1; }

# Trim leading/trailing whitespace.
trim() { printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }

# 1. Baseline .env fail-fast — never let ensure-sandbox-secrets create a
#    half-baked .env that only has sandbox secrets. Trim so a whitespace-only
#    value counts as missing.
[ -f "$ENV_FILE" ] || die ".env not found — run ./setup.sh first."
for required in POSTGRES_PASSWORD REDIS_PASSWORD APP_BASE_URL BASE_URL; do
  val="$(trim "$(sed -n "s/^$required=//p" "$ENV_FILE" | tail -n 1)")"
  [ -n "$val" ] || die "$required missing/empty in .env — run ./setup.sh first (it generates the deploy baseline)."
done

# Back up .env and arrange restore-on-failure. The trap fires on ANY non-zero
# exit or signal; it restores the original .env unless we explicitly mark
# success. It does NOT roll back containers — it only guarantees .env (the
# persistent state the next provision reads) isn't left mid-switch.
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

# 2. Ensure sandbox secrets (signing key + frp token).
bash "$SCRIPT_DIR/ensure-sandbox-secrets.sh"

# 3. Switch ONLY the mode flags (idempotent in-place upsert). Deliberately NOT
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

# 4. Build + bring up with the local override.
log "building api image (baked fs-helper + bubblewrap + ripgrep)..."
docker compose -f docker-compose.yml -f docker-compose.sandbox-local.yml \
  --profile production build api
log "starting api + tunnel-edge with the local override..."
docker compose -f docker-compose.yml -f docker-compose.sandbox-local.yml \
  --profile production up -d api tunnel-edge

# 5. Smoke test (bwrap actually runs under the cap stack).
log "running bwrap exec smoke test..."
bash "$SCRIPT_DIR/sandbox-local-smoke.sh"

# All steps succeeded — keep the new .env.
SUCCESS=1
log "done. Verify a real turn: send a message, then watch:"
log "  docker compose logs -f api | grep -i sandbox"
