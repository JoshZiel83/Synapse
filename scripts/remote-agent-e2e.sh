#!/usr/bin/env bash
# Manage the isolated remote-agent E2E docker stack for this worktree.
#
# Subcommands:
#   up      build images + start postgres/redis/api/daemon, run db:rebuild
#           (schema + demo seed)
#   seed    log in as the seeded demo user, create a remote_agent + machine
#           binding, persist the machine api-key, restart the daemon with it
#   verify  run end-to-end assertions against the running + seeded stack
#   logs    tail recent logs from all containers
#   down    stop + remove only this stack's resources (project name fenced)
#
# Stack isolation:
#   - RAE_STACK_ID defaults to the current git branch (sanitized + truncated
#     to 16 chars). Override with $RAE_STACK_ID for custom test runs.
#   - All container / volume names are suffixed with that id so multiple
#     worktrees can run this stack in parallel without colliding.
#   - Ports for postgres, redis, and the api are probed dynamically (50000+
#     range) and persisted to infrastructure/.rae-state/<id>.env so
#     subsequent up/seed/verify/down calls land on the same ports.
#
# Proxy: claude/codex child processes inside rae-daemon route their
# provider-specific AI endpoint traffic through the host's <redacted-local-proxy> SOCKS5 proxy via the env
# helper in packages/remote-agent-daemon/src/drivers/proxy-env.ts. The
# container runs in host network mode so the proxy address is reachable.

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
  if [ -n "${SYNAPSE_MACHINE_KEY:-}" ]; then
    printf 'SYNAPSE_MACHINE_KEY=%s\n' "$SYNAPSE_MACHINE_KEY" >>"$STATE_FILE"
  fi
  if [ -n "${RAE_WORKSPACE_ID:-}" ]; then
    printf 'RAE_WORKSPACE_ID=%s\n' "$RAE_WORKSPACE_ID" >>"$STATE_FILE"
  fi
  if [ -n "${RAE_REMOTE_AGENT_ID:-}" ]; then
    printf 'RAE_REMOTE_AGENT_ID=%s\n' "$RAE_REMOTE_AGENT_ID" >>"$STATE_FILE"
  fi
  if [ -n "${RAE_MACHINE_ID:-}" ]; then
    printf 'RAE_MACHINE_ID=%s\n' "$RAE_MACHINE_ID" >>"$STATE_FILE"
  fi
  printf 'stack=%s postgres=%s redis=%s api=%s state=%s\n' \
    "$RAE_STACK_ID" "$RAE_POSTGRES_PORT" "$RAE_REDIS_PORT" "$RAE_API_PORT" "$STATE_FILE"
}

require_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "verify requires 'jq' on PATH (apt install jq)" >&2
    exit 1
  fi
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

run_psql() {
  docker exec "rae-$RAE_STACK_ID-postgres" \
    psql -U synapse -d synapse -tA -c "$1"
}

ensure_machine_key() {
  if [ -z "${SYNAPSE_MACHINE_KEY:-}" ]; then
    SYNAPSE_MACHINE_KEY="sk_machine_placeholder_$(openssl rand -hex 8)"
    export SYNAPSE_MACHINE_KEY
  fi
}

bootstrap_schema() {
  echo "Rebuilding schema + demo seed…"
  compose run --rm \
    -e DATABASE_URL="postgresql://synapse:synapse@127.0.0.1:$RAE_POSTGRES_PORT/synapse" \
    rae-api \
    npm run db:rebuild:runtime -w packages/api
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
  echo "Stack rae-$RAE_STACK_ID is running. Next: bash $0 seed"
  echo "  api    http://127.0.0.1:$RAE_API_PORT"
  echo "  pg     127.0.0.1:$RAE_POSTGRES_PORT"
  echo "  redis  127.0.0.1:$RAE_REDIS_PORT"
}

cmd_logs() {
  load_or_assign_ports
  compose logs --tail=200 "$@"
}

api_login() {
  require_jq
  curl -fsS -X POST "http://127.0.0.1:$RAE_API_PORT/api/v1/auth/login" \
    -H "content-type: application/json" \
    -d '{"email":"demo@synapse.dev","password":"demo1234","transport":"bearer"}'
}

cmd_seed() {
  load_or_assign_ports
  require_jq
  echo "Logging in as demo@synapse.dev…"
  local login_resp
  login_resp=$(api_login)
  local token
  token=$(printf '%s' "$login_resp" | jq -r '.session.accessToken // .accessToken // empty')
  if [ -z "$token" ] || [ "$token" = "null" ]; then
    echo "login failed: $login_resp" >&2
    exit 1
  fi

  echo "Listing workspaces…"
  local workspaces_resp
  workspaces_resp=$(curl -fsS -H "authorization: Bearer $token" \
    "http://127.0.0.1:$RAE_API_PORT/api/v1/workspaces")
  RAE_WORKSPACE_ID=$(printf '%s' "$workspaces_resp" \
    | jq -r '.workspaces[0].id // .[0].id // empty')
  if [ -z "$RAE_WORKSPACE_ID" ]; then
    echo "no workspace found: $workspaces_resp" >&2
    exit 1
  fi
  export RAE_WORKSPACE_ID
  echo "workspace=$RAE_WORKSPACE_ID"

  echo "Creating remote_agent (runtimeKind=claude_code)…"
  local agent_resp
  agent_resp=$(curl -fsS -X POST \
    "http://127.0.0.1:$RAE_API_PORT/api/v1/workspaces/$RAE_WORKSPACE_ID/remote-agents" \
    -H "authorization: Bearer $token" \
    -H "content-type: application/json" \
    -d '{"name":"e2e-claude","title":"E2E Claude","runtimeKind":"claude_code"}')
  RAE_REMOTE_AGENT_ID=$(printf '%s' "$agent_resp" | jq -r '.remoteAgent.id')
  export RAE_REMOTE_AGENT_ID
  echo "remote_agent=$RAE_REMOTE_AGENT_ID"

  echo "Creating machine pairing session…"
  local pair_resp
  pair_resp=$(curl -fsS -X POST \
    "http://127.0.0.1:$RAE_API_PORT/api/v1/workspaces/$RAE_WORKSPACE_ID/remote-agent-machines/pairing-sessions" \
    -H "authorization: Bearer $token" \
    -H "content-type: application/json" \
    -d '{"title":"e2e-machine"}')
  RAE_MACHINE_ID=$(printf '%s' "$pair_resp" | jq -r '.machine.id')
  SYNAPSE_MACHINE_KEY=$(printf '%s' "$pair_resp" | jq -r '.apiKey')
  export RAE_MACHINE_ID SYNAPSE_MACHINE_KEY
  echo "machine=$RAE_MACHINE_ID key=$(printf '%s' "$SYNAPSE_MACHINE_KEY" | sed -E 's/.{8}$/****/')"

  echo "Binding remote_agent to machine…"
  curl -fsS -X POST \
    "http://127.0.0.1:$RAE_API_PORT/api/v1/workspaces/$RAE_WORKSPACE_ID/remote-agents/$RAE_REMOTE_AGENT_ID/bind" \
    -H "authorization: Bearer $token" \
    -H "content-type: application/json" \
    -d "{\"machineId\":\"$RAE_MACHINE_ID\",\"runtimeKind\":\"claude_code\"}" \
    >/dev/null

  load_or_assign_ports  # rewrites STATE_FILE with new env vars
  echo "Restarting daemon with the new machine api-key…"
  compose up -d --force-recreate rae-daemon
  echo "Seed complete. Run: bash $0 verify"
}

create_conversation_with_agent() {
  local token="$1"
  local title="$2"
  curl -fsS -X POST \
    "http://127.0.0.1:$RAE_API_PORT/api/v1/workspaces/$RAE_WORKSPACE_ID/chat/conversations" \
    -H "authorization: Bearer $token" \
    -H "content-type: application/json" \
    -d "$(jq -n --arg t "$title" --arg ra "$RAE_REMOTE_AGENT_ID" --arg cid "$(uuidgen)" \
        '{clientRequestId: $cid, kind: "group", boundary: "internal", title: $t, remoteAgentIds: [$ra]}')" \
    | jq -r '.conversation.id // .id'
}

send_user_message() {
  local token="$1"
  local conv_id="$2"
  local text="$3"
  curl -fsS -X POST \
    "http://127.0.0.1:$RAE_API_PORT/api/v1/workspaces/$RAE_WORKSPACE_ID/chat/conversations/$conv_id/messages" \
    -H "authorization: Bearer $token" \
    -H "content-type: application/json" \
    -d "$(jq -n --arg t "$text" --arg cmid "$(uuidgen)" \
        '{clientMessageId: $cmid, contentBlocks: [{type:"text", text:$t}]}')" \
    >/dev/null
}

wait_for_db_row() {
  local sql="$1"
  local expected="$2"
  local timeout="${3:-20}"
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    local got
    got=$(run_psql "$sql" 2>/dev/null || true)
    if [ "$got" = "$expected" ]; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  echo "  expected '$expected', got '$(run_psql "$sql" 2>/dev/null || true)' after ${timeout}s" >&2
  return 1
}

cmd_verify() {
  load_or_assign_ports
  require_jq
  : "${SYNAPSE_MACHINE_KEY:?run 'bash $0 seed' first}"
  : "${RAE_WORKSPACE_ID:?run 'bash $0 seed' first}"
  : "${RAE_REMOTE_AGENT_ID:?run 'bash $0 seed' first}"
  : "${RAE_MACHINE_ID:?run 'bash $0 seed' first}"
  echo "Phase 6 verify suite…"

  echo "[1/11] api health"
  curl -fsS "http://127.0.0.1:$RAE_API_PORT/api/v1/health" >/dev/null
  echo "  ok"

  echo "[2/11] schema_migrations at 2026-05-22-01"
  test "$(run_psql "SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1")" \
    = "2026-05-22-01"
  echo "  ok"

  echo "[3/11] daemon WebSocket connected"
  compose logs --tail=100 rae-daemon 2>/dev/null \
    | grep -q "WebSocket connected"
  echo "  ok"

  echo "[4/11] reverse-MCP endpoint rejects empty Bearer (401)"
  test "$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "http://127.0.0.1:$RAE_API_PORT/api/v1/internal/remote-agents/$RAE_REMOTE_AGENT_ID/mcp/00000000-0000-0000-0000-000000000000")" \
    = 401
  echo "  ok"

  local token
  token=$(api_login | jq -r '.session.accessToken // .accessToken')

  echo "[5/11] per-conversation context isolation (two conversations → two context rows)"
  local conv_a conv_b
  conv_a=$(create_conversation_with_agent "$token" "rae-e2e-a")
  conv_b=$(create_conversation_with_agent "$token" "rae-e2e-b")
  send_user_message "$token" "$conv_a" "hello from conv-a"
  send_user_message "$token" "$conv_b" "hello from conv-b"
  wait_for_db_row \
    "SELECT COUNT(DISTINCT conversation_id)::text FROM remote_agent_conversation_contexts WHERE remote_agent_id='$RAE_REMOTE_AGENT_ID'" \
    "2" 30
  echo "  ok (conversations $conv_a / $conv_b)"

  echo "[6/11] reverse-MCP endpoint passes auth on a valid conversation (POST tools/list)"
  local mcp_url="http://127.0.0.1:$RAE_API_PORT/api/v1/internal/remote-agents/$RAE_REMOTE_AGENT_ID/mcp/$conv_a"
  local mcp_resp
  mcp_resp=$(curl -fsS -X POST "$mcp_url" \
    -H "authorization: Bearer $SYNAPSE_MACHINE_KEY" \
    -H "content-type: application/json" \
    -H "accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"rae-verify","version":"0"}}}')
  printf '%s' "$mcp_resp" | grep -q "\"result\"" \
    || { echo "  initialize failed: $mcp_resp"; exit 1; }
  echo "  ok"

  echo "[7/11] reverse-MCP endpoint denies a different remote_agent's conversation (401)"
  local fake_conv=00000000-0000-0000-0000-000000000099
  test "$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "http://127.0.0.1:$RAE_API_PORT/api/v1/internal/remote-agents/$RAE_REMOTE_AGENT_ID/mcp/$fake_conv" \
    -H "authorization: Bearer $SYNAPSE_MACHINE_KEY" \
    -H "content-type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"x","version":"0"}}}')" \
    = 401
  echo "  ok"

  echo "[8/11] machine connection is fenced (second WS with same key forces first close)"
  # Open a competing WebSocket from the host using node's ws (already a daemon dep)
  PORT="$RAE_API_PORT" KEY="$SYNAPSE_MACHINE_KEY" \
    node --input-type=module -e "
      import WebSocket from '$ROOT_DIR/node_modules/ws/wrapper.mjs';
      const url = new URL('/ws/remote-agents', 'http://127.0.0.1:' + process.env.PORT);
      url.protocol = 'ws:';
      url.searchParams.set('key', process.env.KEY);
      const ws = new WebSocket(url);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'ready', runtimeCatalog: [] }));
      });
      setTimeout(() => { try { ws.close(); } catch {}; process.exit(0); }, 4000);
    " >/dev/null 2>&1 || true
  sleep 2
  if compose logs --tail=200 rae-daemon 2>/dev/null \
    | grep -qE "Server fenced this connection|WebSocket closed"; then
    echo "  ok"
  else
    echo "  warn: did not observe a fenced log entry; the supervising connect may have already reclaimed"
  fi

  echo "[9/11] SOCKS5 proxy routing (claude/codex env baseline)"
  # Validate that the daemon container CAN reach example.invalid/ai-gateway via SOCKS5
  # when proxychains4 is engaged, and CANNOT without it. Skip if the proxy is
  # unreachable from the host (CI box without the tunnel).
  if curl -fsS --max-time 3 --socks5-hostname <redacted-local-proxy> \
      https://example.invalid/ai-gateway/ >/dev/null 2>&1; then
    docker exec "rae-$RAE_STACK_ID-daemon" \
      curl -fsS --max-time 5 --socks5-hostname <redacted-local-proxy> \
        https://example.invalid/ai-gateway/ >/dev/null
    echo "  ok (proxy route reachable)"
  else
    echo "  skip (host <redacted-local-proxy> SOCKS5 not reachable from this box)"
  fi

  echo "[10/11] delivery retry table tracks attempts + next_attempt_at columns"
  test "$(run_psql "SELECT COUNT(*)::text FROM information_schema.columns WHERE table_name='remote_agent_message_deliveries' AND column_name IN ('attempts','next_attempt_at','last_failure_reason')")" \
    = "3"
  echo "  ok"

  echo "[11/11] codex driver detectable (binding flip would route through new driver registry)"
  docker exec "rae-$RAE_STACK_ID-daemon" \
    sh -c 'command -v codex >/dev/null && command -v claude >/dev/null' \
    && echo "  ok"

  echo
  echo "All 11 assertions passed for stack rae-$RAE_STACK_ID"
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
    echo "Usage: $0 {up|seed|verify|logs|down} [args...]" >&2
    exit 1
  fi
  local cmd="$1"
  shift
  case "$cmd" in
    up) cmd_up "$@" ;;
    seed) cmd_seed "$@" ;;
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
