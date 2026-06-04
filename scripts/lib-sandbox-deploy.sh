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

# ── pre-deploy snapshot + state-aware rollback ────────────────────────────────
# A failed deploy must restore each touched service to EXACTLY its pre-deploy
# state — not just "running in the right form". Three axes matter:
#   - existence:  absent vs present (rollback of an absent svc = remove it);
#   - run state:  a present container may be running OR deliberately stopped
#                 (docker inspect succeeds either way) — rolling a stopped svc
#                 back up would wrongly start it;
#   - api form:   which override was layered (docker.sock / SYS_ADMIN / base),
#                 since that's independent of .env and must match the restored .env.
# We snapshot a compact string per service and replay it on failure with all
# managed vars UNSET (so compose honors the restored .env, not a shell flag we
# accepted because it equalled THIS deploy's target).

# api snapshot:  "absent" | "stopped:<form>" | "running:<form>"  (form ∈ base|docker|local)
# tunnel-edge:   "absent" | "stopped"        | "running"          (overrides don't touch it)

_container_running() { # name → "true"/"false"/"" (absent)
  docker inspect "$1" --format '{{.State.Running}}' 2>/dev/null || true
}

_api_form() { # base | docker | local (assumes the container exists)
  local sock caps
  sock="$(docker inspect synapse-api \
    --format '{{range .Mounts}}{{if eq .Destination "/var/run/docker.sock"}}1{{end}}{{end}}' 2>/dev/null || true)"
  caps="$(docker inspect synapse-api \
    --format '{{range .HostConfig.CapAdd}}{{.}} {{end}}' 2>/dev/null || true)"
  if [ -n "$sock" ]; then printf 'docker'
  elif printf '%s' "$caps" | grep -qiE 'SYS_ADMIN'; then printf 'local'
  else printf 'base'; fi
}

predeploy_api_snapshot() {
  local running; running="$(_container_running synapse-api)"
  [ -n "$running" ] || { printf 'absent'; return; }
  if [ "$running" = "true" ]; then printf 'running:%s' "$(_api_form)"
  else printf 'stopped:%s' "$(_api_form)"; fi
}

predeploy_tunnel_snapshot() {
  local running; running="$(_container_running synapse-tunnel-edge)"
  [ -n "$running" ] || { printf 'absent'; return; }
  [ "$running" = "true" ] && printf 'running' || printf 'stopped'
}

# The docker-compose `-f ...` args for a captured api form (empty for base/absent).
compose_args_for_form() {
  case "$1" in
    docker) printf '%s' "-f docker-compose.yml -f docker-compose.sandbox-docker.yml" ;;
    local)  printf '%s' "-f docker-compose.yml -f docker-compose.sandbox-local.yml" ;;
    *)      : ;;  # base / absent → no override args
  esac
}

# Run docker compose with all managed sandbox vars UNSET (so the restored .env
# wins over any shell flag). Usage: _compose_clean <-f args...> -- <compose args...>
_compose_clean() {
  env -u SYNAPSE_SANDBOX_ENABLED -u SYNAPSE_SANDBOX_BACKEND -u SYNAPSE_SANDBOX_TUNNEL \
      -u SYNAPSE_SANDBOX_SERVER_ORIGIN \
    docker compose "$@" >/dev/null 2>&1
}

# Restore synapse-api to a snapshot ("absent" | "stopped:<form>" | "running:<form>").
rollback_api() {
  local snap="$1" form
  case "$snap" in
    absent)
      log "rolling back: the API did not exist before this run — removing the one just created."
      _compose_clean --profile production rm -sf api ;;
    stopped:*)
      form="${snap#stopped:}"
      log "rolling back: the API was stopped before this run — restoring it (form ${form}) then stopping."
      # Recreate in the right form so its config matches the restored .env, then
      # stop it again so we don't leave a service running that was down before.
      # shellcheck disable=SC2086
      _compose_clean $(compose_args_for_form "$form") --profile production up -d --no-start api \
        && _compose_clean --profile production stop api ;;
    running:*)
      form="${snap#running:}"
      log "rolling the running API back to its pre-deploy form (${form})..."
      # shellcheck disable=SC2086
      _compose_clean $(compose_args_for_form "$form") --profile production up -d api ;;
    *) return 1 ;;
  esac
}

# Restore synapse-tunnel-edge to a snapshot ("absent" | "stopped" | "running").
# Overrides don't change tunnel-edge, so base compose args suffice. Note `up -d`
# RECREATES a container whose image/config changed (stop old → start new), so a
# mid-`up` failure can leave a previously-running tunnel-edge DOWN — hence the
# `running` branch must re-assert `up` (idempotent), not no-op.
rollback_tunnel() {
  case "$1" in
    absent)  log "rolling back: tunnel-edge did not exist before this run — removing it."
             _compose_clean --profile production rm -sf tunnel-edge ;;
    stopped) log "rolling back: tunnel-edge was stopped before this run — restoring it stopped."
             # Mirror the API stopped path: ensure the container exists in the
             # compose-defined config, then ensure it is stopped (not left running
             # by a partial up).
             _compose_clean --profile production up -d --no-start tunnel-edge \
               && _compose_clean --profile production stop tunnel-edge ;;
    running) log "rolling back: re-asserting tunnel-edge running (a failed up may have replaced/stopped it)..."
             _compose_clean --profile production up -d tunnel-edge ;;
    *) return 1 ;;
  esac
}

