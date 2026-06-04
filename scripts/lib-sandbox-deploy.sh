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
# won't match the restored .env (e.g. a pre-existing docker deploy would lose its
# socket, a pre-existing local deploy its caps). We infer the form by inspecting
# the live container and emit the matching `-f` args.

# Echo the docker-compose `-f ...` args matching how `synapse-api` is CURRENTLY
# running: docker.sock mounted → the docker override; SYS_ADMIN cap → the local
# override; neither → base only. Empty output = base compose. If the API isn't
# running, also empty (nothing to match).
predeploy_api_compose_args() {
  local sock caps
  sock="$(docker inspect synapse-api \
    --format '{{range .Mounts}}{{if eq .Destination "/var/run/docker.sock"}}1{{end}}{{end}}' 2>/dev/null || true)"
  caps="$(docker inspect synapse-api \
    --format '{{range .HostConfig.CapAdd}}{{.}} {{end}}' 2>/dev/null || true)"
  if [ -n "$sock" ]; then
    printf '%s' "-f docker-compose.yml -f docker-compose.sandbox-docker.yml"
  elif printf '%s' "$caps" | grep -qiE 'SYS_ADMIN'; then
    printf '%s' "-f docker-compose.yml -f docker-compose.sandbox-local.yml"
  fi
  # else: base — print nothing.
}
