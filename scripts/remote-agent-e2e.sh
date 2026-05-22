#!/usr/bin/env bash
# Manage the isolated remote-agent E2E docker stack for this worktree.
#
# Subcommands:
#   up      build images + start postgres/redis/api/daemon, bootstrap the schema
#   verify  run end-to-end smoke assertions against the running stack
#   logs    tail recent logs from all containers
#   down    stop + remove only this stack's resources (project name fenced)
#
# Stack isolation:
#   - RAE_STACK_ID defaults to the current git branch, sanitized + truncated to
#     16 chars. Override with $RAE_STACK_ID for custom test runs.
#   - All container / volume names are suffixed with that id, so multiple
#     worktrees can run this stack in parallel without colliding.
#   - Ports for postgres, redis, and the api are probed dynamically (50000+
#     range) and persisted to infrastructure/.rae-state/<id>.env so subsequent
#     up/verify/down calls land on the same ports.
#
# Proxy: claude/codex child processes inside rae-daemon route their provider-specific AI endpoint
# traffic through the host's <redacted-local-proxy> SOCKS5 proxy via the env helper in
# packages/remote-agent-daemon/src/drivers/proxy-env.ts. The container runs in
# host network mode so the proxy address is reachable.

set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
COMPOSE_FILE="$ROOT_DIR/infrastructure/docker-compose.remote-agent-e2e.yml"
STATE_DIR="$ROOT_DIR/infrastructure/.rae-state"
mkdir -p "$STATE_DIR"

current_branch() {
  git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "rae"
}

sanitize_id() {
  local raw="$1"
  raw=$(printf '%s' "$raw" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9-]+/-/g; s/-+/-/g; s/^-//; s/-$//')
  raw=${raw:-rae}
  printf '%s' "${raw:0:16}"
}

RAE_STACK_ID=${RAE_STACK_ID:-$(sanitize_id "$(current_branch)")}
export RAE_STACK_ID
STATE_FILE="$STATE_DIR/$RAE_STACK_ID.env"

is_port_free() {
  local port="$1"
  ! ss -ltn "( sport = :$port )" 2>/dev/null | tail -n +2 | grep -q .
}

probe_free_port() {
  local start="$1"
  local end="$2"
  local port="$start"
  while [ "$port" -le "$end" ]; do
    if is_port_free "$port"; then
      printf '%s' "$port"
      return 0
    fi
    port=$((port + 1))
  done
  echo "probe_free_port: no free port in $start-$end" >&2
  exit 1
}

load_or_assign_ports() {
  if [ -f "$STATE_FILE" ]; then
    # shellcheck disable=SC1090
    . "$STATE_FILE"
  fi
  if [ -z "${RAE_POSTGRES_PORT:-}" ] || ! is_port_free "$RAE_POSTGRES_PORT"; then
    RAE_POSTGRES_PORT=$(probe_free_port 55000 55999)
  fi
  if [ -z "${RAE_REDIS_PORT:-}" ] || ! is_port_free "$RAE_REDIS_PORT"; then
    RAE_REDIS_PORT=$(probe_free_port 56000 56999)
  fi
  if [ -z "${RAE_API_PORT:-}" ] || ! is_port_free "$RAE_API_PORT"; then
    RAE_API_PORT=$(probe_free_port 53000 53999)
  fi
  export RAE_POSTGRES_PORT RAE_REDIS_PORT RAE_API_PORT
  cat >"$STATE_FILE" <<EOF
RAE_STACK_ID=$RAE_STACK_ID
RAE_POSTGRES_PORT=$RAE_POSTGRES_PORT
RAE_REDIS_PORT=$RAE_REDIS_PORT
RAE_API_PORT=$RAE_API_PORT
EOF
  printf 'stack=%s postgres=%s redis=%s api=%s state=%s\n' \
    "$RAE_STACK_ID" "$RAE_POSTGRES_PORT" "$RAE_REDIS_PORT" "$RAE_API_PORT" "$STATE_FILE"
}

compose() {
  docker compose \
    -p "rae-$RAE_STACK_ID" \
    -f "$COMPOSE_FILE" \
    --env-file "$STATE_FILE" \
    "$@"
}

wait_for_api() {
  local timeout=120
  local elapsed=0
  echo "Waiting for rae-$RAE_STACK_ID-api on 127.0.0.1:$RAE_API_PORT…"
  while [ "$elapsed" -lt "$timeout" ]; do
    if curl -fsS "http://127.0.0.1:$RAE_API_PORT/api/v1/health" >/dev/null 2>&1; then
      echo "api is healthy"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  echo "api did not become healthy within ${timeout}s" >&2
  return 1
}

ensure_machine_key() {
  if [ -z "${SYNAPSE_MACHINE_KEY:-}" ]; then
    SYNAPSE_MACHINE_KEY="sk_machine_$(openssl rand -hex 24)"
    export SYNAPSE_MACHINE_KEY
    echo "Generated SYNAPSE_MACHINE_KEY=$(printf '%s' "$SYNAPSE_MACHINE_KEY" | sed -E 's/.{8}$/****/')"
    cat >>"$STATE_FILE" <<EOF
SYNAPSE_MACHINE_KEY=$SYNAPSE_MACHINE_KEY
EOF
  fi
}

bootstrap_schema() {
  echo "Bootstrapping schema…"
  compose run --rm \
    -e DATABASE_URL="postgresql://synapse:synapse@127.0.0.1:$RAE_POSTGRES_PORT/synapse" \
    rae-api \
    node packages/api/dist/infrastructure/database/bootstrap.js
}

cmd_up() {
  load_or_assign_ports
  ensure_machine_key
  compose build rae-api rae-daemon
  compose up -d rae-postgres rae-redis
  bootstrap_schema
  compose up -d rae-api
  wait_for_api
  compose up -d rae-daemon
  echo
  echo "Stack rae-$RAE_STACK_ID is running."
  echo "  api    http://127.0.0.1:$RAE_API_PORT"
  echo "  pg     127.0.0.1:$RAE_POSTGRES_PORT"
  echo "  redis  127.0.0.1:$RAE_REDIS_PORT"
  echo "  state  $STATE_FILE"
}

cmd_logs() {
  load_or_assign_ports
  compose logs --tail=200 "$@"
}

cmd_verify() {
  load_or_assign_ports
  echo "Phase 6 verify suite (smoke assertions)…"
  echo "[1/4] api health"
  curl -fsS "http://127.0.0.1:$RAE_API_PORT/api/v1/health" | tee /tmp/rae-health
  echo
  echo "[2/4] schema_migrations is at the per-conversation revision"
  docker exec "rae-$RAE_STACK_ID-postgres" \
    psql -U synapse -d synapse -tA \
      -c "SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1" \
    | tee /tmp/rae-schema
  grep -q "2026-05-22-01" /tmp/rae-schema
  echo
  echo "[3/4] daemon process is up and connected"
  compose ps rae-daemon
  compose logs --tail=20 rae-daemon | grep -E "WebSocket connected|Runtime catalog" \
    || { echo "daemon never connected"; exit 1; }
  echo
  echo "[4/4] reverse MCP endpoint rejects an empty Bearer"
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "http://127.0.0.1:$RAE_API_PORT/api/v1/internal/remote-agents/00000000-0000-0000-0000-000000000000/mcp/00000000-0000-0000-0000-000000000000")
  test "$status" = "401" \
    || { echo "expected 401, got $status"; exit 1; }
  echo
  echo "Smoke assertions passed."
  echo
  echo "Remaining assertions (require a real remote_agent + binding) are tracked"
  echo "in AGENTS.md under the Phase 6 follow-up; they need workspace seed +"
  echo "machine pairing + conversation participant fan-out to run."
}

cmd_down() {
  if [ ! -f "$STATE_FILE" ]; then
    echo "No state file for stack '$RAE_STACK_ID' (looked at $STATE_FILE)"
    exit 0
  fi
  # shellcheck disable=SC1090
  . "$STATE_FILE"
  export RAE_POSTGRES_PORT RAE_REDIS_PORT RAE_API_PORT
  echo "Tearing down stack rae-$RAE_STACK_ID…"
  compose down -v --remove-orphans
  rm -f "$STATE_FILE"
}

main() {
  if [ $# -lt 1 ]; then
    echo "Usage: $0 {up|verify|logs|down} [args...]" >&2
    exit 1
  fi
  local cmd="$1"
  shift
  case "$cmd" in
    up) cmd_up "$@" ;;
    verify) cmd_verify "$@" ;;
    logs) cmd_logs "$@" ;;
    down) cmd_down "$@" ;;
    *)
      echo "Unknown subcommand: $cmd" >&2
      exit 1
      ;;
  esac
}

main "$@"
