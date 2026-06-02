#!/usr/bin/env bash
# Shared single-source-of-truth for the per-worktree integration test stack.
#
# Sourced by up.sh / down.sh / run-test.sh with a mode argument:
#   source lib.sh up      # bring-up: reuse .stack-env if usable, else probe & write
#   source lib.sh run     # run a test: trust .stack-env's ports verbatim (never
#                         #   float), AND refuse unless pg/redis are published by
#                         #   THIS worktree's compose project (guards a stale /
#                         #   hand-edited .stack-env from aiming destructive tests
#                         #   at a foreign database)
#   source lib.sh down    # teardown: trust .stack-env's project name, never float
# Or executed directly to inspect the derived values without side effects:
#   bash lib.sh --print
#
# It derives, from the worktree path, a stable per-worktree compose project name
# and four host ports (postgres / redis / spawned-API / prod-API), so different
# worktrees get isolated stacks that can run concurrently. The derivation is
# deterministic (same worktree -> same ports every run, debuggable via fixed
# psql/curl), floating to the next offset band ONLY when the preferred ports are
# occupied by a foreign (non-this-project) listener.
#
# Exposes (and exports for sourced modes):
#   INT_PROJECT_NAME INT_SLUG
#   INT_PG_PORT INT_REDIS_PORT INT_API_PORT INT_PROD_API_PORT
#   INTEGRATION_DIR

_INT_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTEGRATION_DIR="$(dirname "$_INT_LIB_DIR")"
INT_STACK_ENV_FILE="$INTEGRATION_DIR/.stack-env"
WORKTREE_ROOT="$(git -C "$INTEGRATION_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$INTEGRATION_DIR")"

# Port bands: each service gets a 1000-slot band; the four share one offset so
# they stay aligned and reproducible.
_INT_PG_BASE=55000
_INT_REDIS_BASE=56000
_INT_API_BASE=38000
_INT_PROD_API_BASE=39000

# --- derivation -------------------------------------------------------------

_int_compute_base() {
  local hash
  # cksum reads stdin (NOT a path arg) so this hashes the path string itself.
  hash="$(printf '%s' "$WORKTREE_ROOT" | cksum | awk '{print $1}')"
  INT_SLUG="$(basename "$WORKTREE_ROOT" \
    | tr '[:upper:]' '[:lower:]' \
    | tr -c 'a-z0-9' '-' \
    | sed 's/-\{2,\}/-/g; s/^-//; s/-$//' \
    | cut -c1-20)"
  [[ -n "$INT_SLUG" ]] || INT_SLUG="wt"
  INT_BASE_OFFSET=$(( hash % 1000 ))
  INT_PROJECT_NAME="synapse-int-test-${INT_SLUG}-$(( hash % 100000 ))"
  INT_PG_PORT=$(( _INT_PG_BASE + INT_BASE_OFFSET ))
  INT_REDIS_PORT=$(( _INT_REDIS_BASE + INT_BASE_OFFSET ))
  INT_API_PORT=$(( _INT_API_BASE + INT_BASE_OFFSET ))
  INT_PROD_API_PORT=$(( _INT_PROD_API_BASE + INT_BASE_OFFSET ))
}

# --- port ownership / availability -----------------------------------------

# True if some socket is LISTENing on the given local port.
_int_port_busy() {
  ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN
}

# True if a container of THIS compose project publishes the given host port.
# Uses the compose label (not a name prefix) so synapse-int-test-foo can never
# be mistaken for synapse-int-test-foobar.
_int_port_owner_is_ours() {
  local match
  match="$(docker ps \
    --filter "label=com.docker.compose.project=${INT_PROJECT_NAME}" \
    --filter "publish=$1" -q 2>/dev/null)"
  [[ -n "$match" ]]
}

# A port is usable by us if it is free, or already published by our own project.
_int_port_usable() {
  if _int_port_busy "$1"; then
    _int_port_owner_is_ours "$1"
  else
    return 0
  fi
}

# Walk offsets base..base+49 until all four bands are usable; set INT_*_PORT.
_int_resolve_float() {
  local try candidate p
  for try in $(seq 0 49); do
    candidate=$(( (INT_BASE_OFFSET + try) % 1000 ))
    local conflict=0
    for p in \
      $(( _INT_PG_BASE + candidate )) \
      $(( _INT_REDIS_BASE + candidate )) \
      $(( _INT_API_BASE + candidate )) \
      $(( _INT_PROD_API_BASE + candidate )); do
      if ! _int_port_usable "$p"; then conflict=1; break; fi
    done
    if [[ $conflict -eq 0 ]]; then
      INT_PG_PORT=$(( _INT_PG_BASE + candidate ))
      INT_REDIS_PORT=$(( _INT_REDIS_BASE + candidate ))
      INT_API_PORT=$(( _INT_API_BASE + candidate ))
      INT_PROD_API_PORT=$(( _INT_PROD_API_BASE + candidate ))
      return 0
    fi
  done
  echo "[lib.sh] No free port band within 50 offsets of ${INT_BASE_OFFSET} for project ${INT_PROJECT_NAME}." >&2
  echo "[lib.sh] Inspect with: ss -tlnp | grep -E ':(55|56|38|39)[0-9]{3}'  and  docker ps" >&2
  return 1
}

# --- .stack-env (whitelist parser, never sourced) ---------------------------

_int_valid_port() {
  [[ "$1" =~ ^[0-9]+$ ]] && (( $1 >= 1024 && $1 <= 65535 ))
}

# Parse .stack-env line-by-line, accepting only known keys with validated
# values. Returns 0 and sets INT_* on success; 1 if missing/invalid.
_int_load_stack_env() {
  [[ -f "$INT_STACK_ENV_FILE" ]] || return 1
  local name="" pg="" rd="" api="" papi="" key val
  while IFS='=' read -r key val; do
    case "$key" in
      INT_PROJECT_NAME)
        [[ "$val" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || return 1
        name="$val" ;;
      INT_PG_PORT)        _int_valid_port "$val" || return 1; pg="$val" ;;
      INT_REDIS_PORT)     _int_valid_port "$val" || return 1; rd="$val" ;;
      INT_API_PORT)       _int_valid_port "$val" || return 1; api="$val" ;;
      INT_PROD_API_PORT)  _int_valid_port "$val" || return 1; papi="$val" ;;
      ''|'#'*) : ;;   # blank / comment
      *) : ;;          # ignore unknown keys
    esac
  done < "$INT_STACK_ENV_FILE"
  [[ -n "$name" && -n "$pg" && -n "$rd" && -n "$api" && -n "$papi" ]] || return 1
  INT_PROJECT_NAME="$name"
  INT_PG_PORT="$pg"; INT_REDIS_PORT="$rd"
  INT_API_PORT="$api"; INT_PROD_API_PORT="$papi"
  return 0
}

_int_write_stack_env() {
  {
    echo "INT_PROJECT_NAME=$INT_PROJECT_NAME"
    echo "INT_PG_PORT=$INT_PG_PORT"
    echo "INT_REDIS_PORT=$INT_REDIS_PORT"
    echo "INT_API_PORT=$INT_API_PORT"
    echo "INT_PROD_API_PORT=$INT_PROD_API_PORT"
  } > "$INT_STACK_ENV_FILE"
}

# --- top-level resolution ---------------------------------------------------

int_resolve() {
  local mode="${1:-run}"
  _int_compute_base   # always establishes project name + deterministic base ports
  case "$mode" in
    run)
      # Trust the recorded stack's PORTS verbatim — never re-float (a transient
      # listener such as the just-finished spawned test API still holding
      # INT_API_PORT would otherwise shove the whole band to an offset where
      # postgres isn't listening). BUT before a destructive test run we MUST
      # confirm the DB/Redis we're about to point at are actually OUR compose
      # project's containers, not a stale/hand-edited .stack-env aimed at some
      # other high-port Postgres. The pg/redis ports are real docker containers
      # (unlike the API port), so label-ownership is a reliable check here.
      _int_load_stack_env || true
      local owner_pg owner_redis
      owner_pg="$(docker ps \
        --filter "label=com.docker.compose.project=${INT_PROJECT_NAME}" \
        --filter "publish=${INT_PG_PORT}" -q 2>/dev/null)"
      owner_redis="$(docker ps \
        --filter "label=com.docker.compose.project=${INT_PROJECT_NAME}" \
        --filter "publish=${INT_REDIS_PORT}" -q 2>/dev/null)"
      if [[ -z "$owner_pg" || -z "$owner_redis" ]]; then
        echo "[lib.sh] REFUSING run: postgres(${INT_PG_PORT})/redis(${INT_REDIS_PORT}) are not published by this worktree's compose project '${INT_PROJECT_NAME}'." >&2
        echo "[lib.sh] Bring the stack up first:  bash $(dirname "${BASH_SOURCE[0]}")/up.sh" >&2
        echo "[lib.sh] (This guard prevents a stale/edited .stack-env from aiming destructive tests at a foreign database.)" >&2
        return 1
      fi
      ;;
    down|print)
      # Trust the recorded stack so we tear down / report EXACTLY what `up`
      # established; never re-float on port drift (the file's project name wins).
      # No ownership gate here: down must work even after the containers are
      # already gone, and print is side-effect-free.
      _int_load_stack_env || true
      ;;
    up)
      if _int_load_stack_env; then
        # Reuse recorded ports only if still usable (ours or free).
        local p ok=1
        for p in "$INT_PG_PORT" "$INT_REDIS_PORT" "$INT_API_PORT" "$INT_PROD_API_PORT"; do
          if ! _int_port_usable "$p"; then ok=0; break; fi
        done
        if [[ $ok -ne 1 ]]; then
          _int_resolve_float || return 1
          _int_write_stack_env
        fi
      else
        _int_resolve_float || return 1
        _int_write_stack_env
      fi
      ;;
    *)
      echo "[lib.sh] unknown mode: $mode (expected up|run|down|print)" >&2
      return 1 ;;
  esac
  return 0
}

# --- invocation -------------------------------------------------------------

_int_mode_arg="${1:-}"
if [[ "$_int_mode_arg" == "--print" ]]; then
  # Executed directly: show what is / would be used, no writes, no float.
  int_resolve print || exit 1
  echo "INT_PROJECT_NAME=$INT_PROJECT_NAME"
  echo "INT_SLUG=$INT_SLUG"
  echo "INT_PG_PORT=$INT_PG_PORT"
  echo "INT_REDIS_PORT=$INT_REDIS_PORT"
  echo "INT_API_PORT=$INT_API_PORT"
  echo "INT_PROD_API_PORT=$INT_PROD_API_PORT"
else
  # Sourced with a mode (default run). Export for the caller + docker compose.
  int_resolve "${_int_mode_arg:-run}" || return 1 2>/dev/null || exit 1
  export INT_PROJECT_NAME INT_SLUG INTEGRATION_DIR
  export INT_PG_PORT INT_REDIS_PORT INT_API_PORT INT_PROD_API_PORT
fi
