#!/usr/bin/env bash
# Shared helpers for the sandbox deploy scripts (deploy-sandbox-docker.sh /
# deploy-sandbox-local.sh). Sourced, not executed. Requires: REPO_ROOT, ENV_FILE,
# and a `die`/`log` already defined by the caller. Bash-only (uses ${!name}).

# ── shell-override guards ─────────────────────────────────────────────────────
# compose interpolates ${VAR:-default} from the SHELL before .env. Two hazards:
#   - a shell var that is SET (even to empty/whitespace) shadows .env entirely —
#     `${VAR:-default}` uses the *default* when VAR is set-but-empty, NOT .env;
#   - a non-empty shell value silently overrides what we wrote to .env.
# So for any var we manage, if it is SET in the shell at all it must match RAW-
# EXACT (no trim) the value we intend. Use ${!name+x} to tell unset from set-empty.

# A managed FLAG must, if set in the shell, equal `want` exactly (else compose
# would deploy a different value than our .env + logs claim).
assert_shell_flag() {
  local name="$1" want="$2"
  if [ -n "${!name+x}" ]; then
    [ "${!name}" = "$want" ] || die "shell env $name='${!name}' is set and would override .env (compose uses the shell value, or its default when set-empty); unset it or set it exactly to '$want' before deploying."
  fi
}

# A managed SECRET must, if set in the shell, equal the .env value EXACTLY (raw —
# leading/trailing spaces matter: tunnel-edge gets the token verbatim while the
# API trims it, so a padded shell token breaks frp auth).
assert_shell_secret() {
  local name="$1" envval
  if [ -n "${!name+x}" ]; then
    envval="$(sed -n "s/^$name=//p" "$ENV_FILE" | tail -n 1)"
    [ "${!name}" = "$envval" ] || die "shell env $name is set and differs from .env (raw value); compose would use the shell value. Unset it (or align it byte-for-byte) before deploying."
  fi
}

# ── pre-deploy form capture + form-aware rollback ─────────────────────────────
# The running API's compose "form" (which override files were layered) is
# independent of .env's backend. On a failed deploy we must restore the form the
# API had BEFORE this run — not blindly drop to base — else the running container
# won't match the restored .env (a pre-existing docker deploy would lose its
# socket, a pre-existing local deploy its caps). And if the API did NOT exist
# before this run, rolling back must REMOVE the one we created, not start a new
# base API. So we capture four states: absent | base | docker | local.

# Echo how `synapse-api` exists RIGHT NOW (call before the deploy mutates it):
#   absent  — no such container
#   docker  — running with the host docker.sock mounted (docker-backend override)
#   local   — running with SYS_ADMIN (containerized-local override)
#   base    — running with neither (plain compose)
predeploy_api_form() {
  local exists sock caps
  exists="$(docker inspect synapse-api --format '1' 2>/dev/null || true)"
  [ -n "$exists" ] || { printf 'absent'; return; }
  sock="$(docker inspect synapse-api \
    --format '{{range .Mounts}}{{if eq .Destination "/var/run/docker.sock"}}1{{end}}{{end}}' 2>/dev/null || true)"
  caps="$(docker inspect synapse-api \
    --format '{{range .HostConfig.CapAdd}}{{.}} {{end}}' 2>/dev/null || true)"
  if [ -n "$sock" ]; then printf 'docker'
  elif printf '%s' "$caps" | grep -qiE 'SYS_ADMIN'; then printf 'local'
  else printf 'base'; fi
}

# The docker-compose `-f ...` args for a captured form (empty for base/absent).
compose_args_for_form() {
  case "$1" in
    docker) printf '%s' "-f docker-compose.yml -f docker-compose.sandbox-docker.yml" ;;
    local)  printf '%s' "-f docker-compose.yml -f docker-compose.sandbox-local.yml" ;;
    *)      : ;;  # base / absent → no override args
  esac
}

# Roll the API back to its pre-deploy form, run with ALL managed vars UNSET so
# compose honors the restored .env (not a shell flag we accepted because it
# equalled THIS deploy's target — which is the opposite of the rollback target).
# `absent` → stop+remove the API we created this run; otherwise re-up in the
# captured form. Best-effort; the caller logs a warning on failure.
rollback_api() {
  local form="$1" args
  if [ "$form" = "absent" ]; then
    log "rolling back: the API did not exist before this run — removing the one just created."
    env -u SYNAPSE_SANDBOX_ENABLED -u SYNAPSE_SANDBOX_BACKEND -u SYNAPSE_SANDBOX_TUNNEL \
        -u SYNAPSE_SANDBOX_SERVER_ORIGIN \
      docker compose --profile production rm -sf api >/dev/null 2>&1 \
      || return 1
    return 0
  fi
  args="$(compose_args_for_form "$form")"
  log "rolling the running API back to its pre-deploy form (${form})..."
  # shellcheck disable=SC2086
  env -u SYNAPSE_SANDBOX_ENABLED -u SYNAPSE_SANDBOX_BACKEND -u SYNAPSE_SANDBOX_TUNNEL \
      -u SYNAPSE_SANDBOX_SERVER_ORIGIN \
    docker compose $args --profile production up -d api >/dev/null 2>&1
}

