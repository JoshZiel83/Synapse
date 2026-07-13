#!/usr/bin/env bash
set -euo pipefail

# Deploy the DOCKER:BARE (Mode-B) actor sandbox backend: each session runs in a
# STOCK hardened keepalive container (`sleep infinity`) that the API drives over
# the DIRECT data plane via `docker run` / `docker exec` (DooD through the host
# docker socket). Unlike the docker RESIDENT backend, docker:bare has NO
# in-sandbox device-runtime, NO frp tunnel, and NO signed device envelopes — the
# API talks straight to the container's fs/exec. This is the reduced-fidelity,
# tunnel-free sandbox backend; see deploy.md §8b.
#
# What it does:
#   1. Fail-fast if .env is missing its deploy baseline (POSTGRES_PASSWORD,
#      REDIS_PASSWORD, APP_BASE_URL, BASE_URL).
#   2. Switch the mode flags in .env (SANDBOX_PROVIDER=docker, SANDBOX_MODE=bare).
#   3. Best-effort pre-pull the bare base image on the HOST daemon (the API
#      `docker run`s it via the host socket, so it must resolve there).
#   4. Build the api image, then bring up api ONLY WITH the docker-socket override
#      (bare needs the socket for `docker run`/`docker exec`, but NOT tunnel-edge).
#
# Deliberately NOT done (vs deploy-sandbox-docker.sh, which is RESIDENT):
#   - No FRP_SHARED_TOKEN / SYNAPSE_DEVICE_ENVELOPE_SIGNING_KEY provisioning or
#     shell-secret guards: docker:bare has no frp tunnel and signs no envelopes,
#     so it needs neither secret.
#   - No tunnel-edge (frps) build or bring-up.
#   - No cloud-sandbox (synapse-device-runtime) image build: bare runs a stock
#     base image (SANDBOX_DOCKER_BARE_IMAGE, default debian:bookworm-slim).
#   - No SANDBOX_SERVER_ORIGIN guard: bare never dials back to the API.
#
# Failure handling: .env is backed up OUTSIDE the repo (so the secret-bearing copy
# never enters a docker build context) and restored on failure / interruption, and
# the API is rolled back to its pre-deploy operational snapshot.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"
ENV_FILE="$REPO_ROOT/.env"

log() { echo "[deploy-sandbox-docker-bare] $*" >&2; }
die() { echo "[deploy-sandbox-docker-bare] ERROR: $*" >&2; exit 1; }
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
#     shell var makes compose use the default, ignoring .env). We manage BOTH the
#     provider and the mode here, so both are guarded.
assert_shell_flag SANDBOX_PROVIDER docker
assert_shell_flag SANDBOX_MODE bare

# Snapshot how the API exists BEFORE we touch anything, so a failed deploy can
# restore it to its pre-deploy operational state (existence / run state / api
# override form — NOT the pre-deploy image id; see lib header). tunnel-edge is
# untouched by a bare deploy, so it is not snapshotted here.
PREDEPLOY_API_SNAPSHOT="$(predeploy_api_snapshot)"

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

# Track whether we (re)started the API this run, so a FINAL bring-up failure rolls
# it back to its pre-deploy snapshot. Set to 1 right before the `up`.
API_STARTED=0
SUCCESS=0
cleanup() {
  if [ "$SUCCESS" -ne 1 ]; then
    if [ -f "$ENV_BACKUP" ]; then
      cp -p "$ENV_BACKUP" "$ENV_FILE"
      log "deploy failed — restored the original .env (sandbox flags reverted)."
    fi
    # The rollback restores the API's pre-deploy operational snapshot; rollback_api
    # unsets managed vars so compose honors the restored .env, not a shell flag we
    # accepted for THIS deploy.
    if [ "$API_STARTED" -eq 1 ]; then
      rollback_api "$PREDEPLOY_API_SNAPSHOT" \
        || log "WARNING: could not auto-roll-back the API container — check 'docker compose ps' and re-run with the restored .env."
    fi
  fi
  rm -f "$ENV_BACKUP"
}
trap cleanup EXIT

# 2. Switch the two mode flags (idempotent in-place upsert). No secrets: docker:bare
#    has no frp tunnel and signs no device envelopes.
upsert() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i -E "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    if [ -n "$(tail -c1 "$ENV_FILE")" ]; then printf '\n' >>"$ENV_FILE"; fi
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
}
upsert SANDBOX_PROVIDER docker
upsert SANDBOX_MODE bare
log "set SANDBOX_PROVIDER=docker + SANDBOX_MODE=bare (docker:bare, tunnel-free)."

# 3. Best-effort pre-pull of the bare base image on the HOST daemon. The API runs
#    `docker run <bareImage>` via the host socket (DooD), so the image must resolve
#    on the HOST — otherwise the first sandbox provision pays a cold pull (or fails
#    if the host has no egress). Resolve the effective value the same way compose
#    will: shell (non-empty) → .env → the compose default. Non-fatal.
BARE_IMAGE="$(trim "${SANDBOX_DOCKER_BARE_IMAGE:-}")"
[ -n "$BARE_IMAGE" ] || BARE_IMAGE="$(trim "$(sed -n 's/^SANDBOX_DOCKER_BARE_IMAGE=//p' "$ENV_FILE" | tail -n 1)")"
[ -n "$BARE_IMAGE" ] || BARE_IMAGE="debian:bookworm-slim"
log "pre-pulling the bare base image on the host: ${BARE_IMAGE} ..."
docker pull "$BARE_IMAGE" \
  || log "WARNING: could not pre-pull ${BARE_IMAGE}; the API will pull it on first sandbox provision (needs host egress)."

# 4. Build the api image, then bring up api ONLY with the docker-socket override.
#    The override MUST stay: docker:bare uses `docker run`/`docker exec` from inside
#    the API container, which needs the host docker socket. tunnel-edge is NOT part
#    of a bare deploy.
log "building api image (baked fs-helper)..."
docker compose --profile production build api
log "starting api with the docker-socket override (no tunnel-edge)..."
API_STARTED=1
docker compose -f docker-compose.yml -f docker-compose.sandbox-docker.yml \
  --profile production up -d api

SUCCESS=1
log "done. Verify the docker:bare backend is dispatchable:"
log "  docker compose exec api docker version >/dev/null && echo socket-ok"
log "  docker compose logs -f api | grep -i sandbox   # then trigger a turn → a synapse-sbx-bare-* container appears"
