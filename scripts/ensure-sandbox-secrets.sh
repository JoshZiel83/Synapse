#!/usr/bin/env bash
set -euo pipefail

# Ensure the TWO sandbox secrets exist in .env, and nothing else.
#
#   SYNAPSE_DEVICE_ENVELOPE_SIGNING_KEY  — Ed25519 key (base64) for device-dispatch
#                                          envelopes.
#   FRP_SHARED_TOKEN                      — shared frp token (frps + frpc + the
#                                          docker sandbox backend must all agree).
#
# Deliberately NARROW: unlike ./setup.sh (which also upserts AI / domain / Next /
# Expo deploy variables), this touches only the two sandbox secrets — safe to run
# on an already-deployed .env right before enabling the sandbox.
#
# Behavior:
#   - REQUIRES .env to already exist (./setup.sh generates the baseline:
#     POSTGRES_PASSWORD, APP_BASE_URL, etc.). Refuses to create a half-baked .env
#     holding only sandbox secrets — the compose api service would then fail its
#     POSTGRES_PASSWORD/APP_BASE_URL/... required-var checks.
#   - Generates a secret only when its line is MISSING or its value is EMPTY /
#     whitespace-only. An existing non-empty value is kept (rotating the signing
#     key would orphan already-paired devices; the frp token must stay in sync
#     across services).
#   - Preserves .env's `600` permissions and guarantees a trailing newline.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"

log() { echo "[ensure-sandbox-secrets] $*" >&2; }
die() { echo "[ensure-sandbox-secrets] ERROR: $*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die ".env not found at $ENV_FILE — run ./setup.sh first (it generates the deploy baseline)."

# Current value of KEY in .env (empty string if missing or value-empty).
env_value() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }

# Trim leading/trailing whitespace (so a value like "   " counts as empty).
trim() { printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }

# Append KEY=VALUE, guaranteeing the file ends in a newline first so we never
# concatenate onto a no-newline last line.
append_var() {
  local key="$1" value="$2"
  if [ -n "$(tail -c1 "$ENV_FILE")" ]; then printf '\n' >>"$ENV_FILE"; fi
  printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
}

ensure_secret() {
  local key="$1" gen="$2" current
  current="$(trim "$(env_value "$key")")"
  if [ -n "$current" ]; then
    log "$key already set — keeping existing value."
    return
  fi
  # Missing line OR present-but-empty/whitespace: drop any such line, then append
  # fresh. `grep -v` exits 1 when EVERY line matches (e.g. .env is only this key),
  # which under `set -e` would skip the rewrite and leave the stale empty line —
  # producing a duplicate key once we append. `|| true` keeps the rewrite running.
  if grep -q "^$key=" "$ENV_FILE"; then
    local tmp; tmp="$(mktemp)"
    grep -v "^$key=" "$ENV_FILE" >"$tmp" || true
    cat "$tmp" >"$ENV_FILE"
    rm -f "$tmp"
  fi
  local value; value="$($gen)"
  append_var "$key" "$value"
  log "$key generated."
}

gen_signing_key() { openssl genpkey -algorithm Ed25519 2>/dev/null | base64 | tr -d '\n'; }
gen_frp_token()   { openssl rand -hex 32; }

# Preserve (or tighten to) 600 around the edit.
chmod 600 "$ENV_FILE" 2>/dev/null || true
ensure_secret SYNAPSE_DEVICE_ENVELOPE_SIGNING_KEY gen_signing_key
ensure_secret FRP_SHARED_TOKEN gen_frp_token
chmod 600 "$ENV_FILE" 2>/dev/null || true

log "done."
