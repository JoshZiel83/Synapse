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

# 1. Baseline .env fail-fast.
[ -f "$ENV_FILE" ] || die ".env not found — run ./setup.sh first."
for required in POSTGRES_PASSWORD REDIS_PASSWORD APP_BASE_URL BASE_URL; do
  val="$(trim "$(sed -n "s/^$required=//p" "$ENV_FILE" | tail -n 1)")"
  [ -n "$val" ] || die "$required missing/empty in .env — run ./setup.sh first (it generates the deploy baseline)."
done

# 2. Reject conflicting shell env. Compose interpolates ${VAR} from the shell
#    first, then .env — so a shell export of a managed flag would override what we
#    write to .env and make the running container disagree with our logs. Demand
#    the shell value (if set) match what we're about to deploy.
assert_shell_flag() {
  local name="$1" want="$2" cur
  cur="$(trim "$(printenv "$name" 2>/dev/null || true)")"
  [ -z "$cur" ] || [ "$cur" = "$want" ] || \
    die "shell env $name='$cur' would override .env (compose precedence); unset it or set it to '$want' before deploying."
}
assert_shell_flag SYNAPSE_SANDBOX_ENABLED true
assert_shell_flag SYNAPSE_SANDBOX_BACKEND local
# A shell loopback origin is fine for local (the override sets it anyway); only a
# non-loopback custom value would be surprising. Leave it unconstrained here.

# Back up .env OUTSIDE the repo (mktemp default $TMPDIR) so the secret-bearing
# copy is never in the docker build context, and restore on failure.
ENV_BACKUP="$(mktemp "${TMPDIR:-/tmp}/synapse-env-predeploy.XXXXXX")"
cp -p "$ENV_FILE" "$ENV_BACKUP"
SUCCESS=0
cleanup() {
  if [ "$SUCCESS" -ne 1 ] && [ -f "$ENV_BACKUP" ]; then
    cp -p "$ENV_BACKUP" "$ENV_FILE"
    log "deploy failed — restored the original .env (sandbox flags reverted)."
  fi
  rm -f "$ENV_BACKUP"
}
trap cleanup EXIT

# 3. Ensure sandbox secrets (signing key + frp token).
bash "$SCRIPT_DIR/ensure-sandbox-secrets.sh"

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

# 6. Bring up the real stack. Build tunnel-edge too (a stale local image won't be
#    rebuilt by `up` otherwise).
log "starting api + tunnel-edge with the local override..."
"${COMPOSE[@]}" build tunnel-edge
"${COMPOSE[@]}" up -d api tunnel-edge

SUCCESS=1
log "done. Verify a real turn: send a message, then watch:"
log "  docker compose logs -f api | grep -i sandbox"
