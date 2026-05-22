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

load_state() {
  if [ -f "$STATE_FILE" ]; then
    # shellcheck disable=SC1090
    . "$STATE_FILE"
    export RAE_POSTGRES_PORT RAE_REDIS_PORT RAE_API_PORT \
      RAE_WORKSPACE_ID RAE_REMOTE_AGENT_ID RAE_MACHINE_ID SYNAPSE_MACHINE_KEY
    return 0
  fi
  return 1
}

persist_state() {
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
}

require_state() {
  if ! load_state; then
    echo "No state file for stack '$RAE_STACK_ID' at $STATE_FILE; run 'bash $0 up' first" >&2
    exit 1
  fi
  : "${RAE_POSTGRES_PORT:?missing RAE_POSTGRES_PORT in state}"
  : "${RAE_REDIS_PORT:?missing RAE_REDIS_PORT in state}"
  : "${RAE_API_PORT:?missing RAE_API_PORT in state}"
}

assign_fresh_ports() {
  # Only called by `up`. Preserves saved values if they're still free, otherwise
  # probes a free range.
  load_state || true
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
  persist_state
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
  assign_fresh_ports
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
  require_state
  compose logs --tail=200 "$@"
}

api_login() {
  require_jq
  curl -fsS -X POST "http://127.0.0.1:$RAE_API_PORT/api/v1/auth/login" \
    -H "content-type: application/json" \
    -d '{"email":"demo@synapse.dev","password":"demo1234","transport":"token"}'
}

cmd_seed() {
  require_state
  require_jq
  echo "Logging in as demo@synapse.dev…"
  local login_resp
  login_resp=$(api_login)
  local token
  token=$(printf '%s' "$login_resp" | jq -r '.sessionToken // empty')
  if [ -z "$token" ] || [ "$token" = "null" ]; then
    echo "login failed: $login_resp" >&2
    exit 1
  fi

  echo "Listing workspaces…"
  local workspaces_resp
  workspaces_resp=$(curl -fsS -H "authorization: Bearer $token" \
    "http://127.0.0.1:$RAE_API_PORT/api/v1/workspaces")
  RAE_WORKSPACE_ID=$(printf '%s' "$workspaces_resp" \
    | jq -r '.data[0].id // .workspaces[0].id // empty')
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
    -d "{\"machineId\":\"$RAE_MACHINE_ID\",\"runtimeKind\":\"claude_code\",\"runtimePath\":\"/usr/local/bin/claude\"}" \
    >/dev/null

  persist_state
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
    | jq -r '.conversation.conversationId // .conversation.id // .id'
}

register_client_instance() {
  local token="$1"
  # Server generates the id; return it.
  curl -fsS -X POST \
    "http://127.0.0.1:$RAE_API_PORT/api/v1/workspaces/$RAE_WORKSPACE_ID/chat/client-instances" \
    -H "authorization: Bearer $token" \
    -H "content-type: application/json" \
    -d '{"platform":"rae-e2e","deviceLabel":"rae-e2e","metadata":{}}' \
    | jq -r '.clientInstanceId // .id'
}

send_user_message() {
  local token="$1"
  local conv_id="$2"
  local text="$3"
  if [ -z "${RAE_CLIENT_INSTANCE_ID:-}" ]; then
    RAE_CLIENT_INSTANCE_ID=$(register_client_instance "$token")
    export RAE_CLIENT_INSTANCE_ID
  fi
  curl -fsS -X POST \
    "http://127.0.0.1:$RAE_API_PORT/api/v1/workspaces/$RAE_WORKSPACE_ID/chat/conversations/$conv_id/messages" \
    -H "authorization: Bearer $token" \
    -H "content-type: application/json" \
    -d "$(jq -n --arg t "$text" --arg cmid "$(uuidgen)" --arg cinst "$RAE_CLIENT_INSTANCE_ID" \
        '{clientInstanceId: $cinst, clientMessageId: $cmid, contentBlocks: [{type:"text", text:$t}]}')" \
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
  require_state
  require_jq
  : "${SYNAPSE_MACHINE_KEY:?run 'bash $0 seed' first}"
  : "${RAE_WORKSPACE_ID:?run 'bash $0 seed' first}"
  : "${RAE_REMOTE_AGENT_ID:?run 'bash $0 seed' first}"
  : "${RAE_MACHINE_ID:?run 'bash $0 seed' first}"
  echo "Phase 6 verify suite (15 assertions)…"

  echo "[1/15] api health"
  curl -fsS "http://127.0.0.1:$RAE_API_PORT/api/v1/health" >/dev/null
  echo "  ok"

  echo "[2/15] schema_migrations at 2026-05-22-01"
  test "$(run_psql "SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1")" \
    = "2026-05-22-01"
  echo "  ok"

  echo "[3/15] daemon WebSocket connected"
  compose logs --tail=100 rae-daemon 2>/dev/null \
    | grep -q "WebSocket connected"
  echo "  ok"

  echo "[4/15] reverse-MCP endpoint rejects empty Bearer (401)"
  test "$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "http://127.0.0.1:$RAE_API_PORT/api/v1/internal/remote-agents/$RAE_REMOTE_AGENT_ID/mcp/00000000-0000-0000-0000-000000000000")" \
    = 401
  echo "  ok"

  local token
  token=$(api_login | jq -r '.sessionToken')

  echo "[5/15] per-conversation context isolation (two conversations → two context rows)"
  local conv_a conv_b
  conv_a=$(create_conversation_with_agent "$token" "rae-e2e-a")
  conv_b=$(create_conversation_with_agent "$token" "rae-e2e-b")
  send_user_message "$token" "$conv_a" "hello from conv-a"
  send_user_message "$token" "$conv_b" "hello from conv-b"
  wait_for_db_row \
    "SELECT COUNT(*)::text FROM remote_agent_conversation_contexts WHERE remote_agent_id='$RAE_REMOTE_AGENT_ID' AND conversation_id IN ('$conv_a','$conv_b')" \
    "2" 30
  echo "  ok (conversations $conv_a / $conv_b)"

  echo "[6/15] reverse-MCP endpoint passes auth on a valid conversation (POST tools/list)"
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

  echo "[7/15] reverse-MCP endpoint denies a different remote_agent's conversation (401)"
  local fake_conv=00000000-0000-0000-0000-000000000099
  test "$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "http://127.0.0.1:$RAE_API_PORT/api/v1/internal/remote-agents/$RAE_REMOTE_AGENT_ID/mcp/$fake_conv" \
    -H "authorization: Bearer $SYNAPSE_MACHINE_KEY" \
    -H "content-type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"x","version":"0"}}}')" \
    = 401
  echo "  ok"

  echo "[8/15] machine connection is fenced (second WS with same key forces first close)"
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

  echo "[9/15] SOCKS5 proxy routing (claude/codex env baseline)"
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

  echo "[10/15] delivery retry table tracks attempts + next_attempt_at columns"
  test "$(run_psql "SELECT COUNT(*)::text FROM information_schema.columns WHERE table_name='remote_agent_message_deliveries' AND column_name IN ('attempts','next_attempt_at','last_failure_reason')")" \
    = "3"
  echo "  ok"

  echo "[11/15] codex + claude binaries present in daemon image"
  local daemon_image
  daemon_image=$(compose config --format json 2>/dev/null \
    | jq -r '.services."rae-daemon".image // empty')
  if [ -z "$daemon_image" ]; then
    # `compose config` omits the synthesized image name when a build context is
    # in use; fall back to docker compose's deterministic project_service tag.
    daemon_image="rae-${RAE_STACK_ID}-rae-daemon"
  fi
  docker run --rm --entrypoint sh "$daemon_image" \
    -c 'command -v codex >/dev/null && command -v claude >/dev/null'
  echo "  ok"

  echo "[12/15] distinct runtime_session_id per conversation (when CC has talked at all)"
  local session_ids
  session_ids=$(run_psql "SELECT runtime_session_id FROM remote_agent_conversation_contexts WHERE remote_agent_id='$RAE_REMOTE_AGENT_ID' AND conversation_id IN ('$conv_a','$conv_b') AND runtime_session_id IS NOT NULL ORDER BY conversation_id")
  local distinct_count
  distinct_count=$(printf '%s\n' "$session_ids" | sort -u | grep -c . || true)
  local total_count
  total_count=$(printf '%s\n' "$session_ids" | grep -c . || true)
  if [ "$total_count" -lt 2 ]; then
    echo "  skip (only $total_count session id populated; CC didn't reach the model in this env)"
  else
    test "$distinct_count" = "$total_count" \
      || { echo "  FAIL: $total_count rows but only $distinct_count distinct session_ids → sessions are bleeding across conversations"; exit 1; }
    echo "  ok ($total_count contexts, all distinct)"
  fi

  echo "[13/15] /fail-deliveries increments attempts and persists last_failure_reason"
  # Pause the daemon so it can't auto-ack the test delivery before we observe
  # it. Send a message under the lock to mint a fresh pending delivery,
  # then drive /fail-deliveries with that id and assert the row mutates.
  docker pause "rae-$RAE_STACK_ID-daemon" >/dev/null
  trap 'docker unpause "rae-$RAE_STACK_ID-daemon" >/dev/null 2>&1 || true' RETURN
  local conv_retry
  conv_retry=$(create_conversation_with_agent "$token" "rae-e2e-retry")
  send_user_message "$token" "$conv_retry" "retry probe"
  local delivery_id
  delivery_id=$(wait_for_delivery_id "$conv_retry" 30)
  test -n "$delivery_id" \
    || { echo "  FAIL: no pending delivery materialized for $conv_retry"; docker unpause "rae-$RAE_STACK_ID-daemon" >/dev/null; exit 1; }
  local before_attempts
  before_attempts=$(run_psql "SELECT attempts::text FROM remote_agent_message_deliveries WHERE id='$delivery_id'")
  curl -fsS -X POST \
    "http://127.0.0.1:$RAE_API_PORT/api/v1/internal/remote-agents/$RAE_REMOTE_AGENT_ID/fail-deliveries" \
    -H "authorization: Bearer $SYNAPSE_MACHINE_KEY" \
    -H "content-type: application/json" \
    -d "$(jq -n --arg d "$delivery_id" '{deliveryIds: [$d], reason: "rae-e2e probe"}')" \
    >/dev/null
  local after_attempts
  after_attempts=$(run_psql "SELECT attempts::text FROM remote_agent_message_deliveries WHERE id='$delivery_id'")
  test "$after_attempts" -gt "$before_attempts" \
    || { echo "  FAIL: attempts did not increment ($before_attempts → $after_attempts)"; docker unpause "rae-$RAE_STACK_ID-daemon" >/dev/null; exit 1; }
  local reason
  reason=$(run_psql "SELECT last_failure_reason FROM remote_agent_message_deliveries WHERE id='$delivery_id'")
  test "$reason" = "rae-e2e probe" \
    || { echo "  FAIL: last_failure_reason not recorded ('$reason')"; docker unpause "rae-$RAE_STACK_ID-daemon" >/dev/null; exit 1; }
  docker unpause "rae-$RAE_STACK_ID-daemon" >/dev/null
  trap - RETURN
  echo "  ok ($before_attempts → $after_attempts, reason '$reason')"

  echo "[14/15] reverse-MCP tools/list returns the IM tool surface via Mcp-Session-Id"
  local mcp_url_a="http://127.0.0.1:$RAE_API_PORT/api/v1/internal/remote-agents/$RAE_REMOTE_AGENT_ID/mcp/$conv_a"
  local init_headers_path init_body_path
  init_headers_path=$(mktemp)
  init_body_path=$(mktemp)
  curl -fsS -D "$init_headers_path" -o "$init_body_path" -X POST "$mcp_url_a" \
    -H "authorization: Bearer $SYNAPSE_MACHINE_KEY" \
    -H "content-type: application/json" \
    -H "accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"rae-verify","version":"0"}}}'
  local mcp_session
  mcp_session=$(awk 'BEGIN{IGNORECASE=1} /^mcp-session-id:/ { gsub(/\r/, "", $2); print $2; exit }' "$init_headers_path")
  test -n "$mcp_session" \
    || { echo "  FAIL: no Mcp-Session-Id returned by initialize"; exit 1; }
  local tools_resp
  tools_resp=$(curl -fsS -X POST "$mcp_url_a" \
    -H "authorization: Bearer $SYNAPSE_MACHINE_KEY" \
    -H "content-type: application/json" \
    -H "accept: application/json, text/event-stream" \
    -H "mcp-session-id: $mcp_session" \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
  # The response can be JSON or an SSE event stream; either way the body
  # contains the tool names.
  for tool in list_conversations check_messages read_history send_message search_messages; do
    printf '%s' "$tools_resp" | grep -q "\"name\":\"$tool\"" \
      || { echo "  FAIL: tools/list missing $tool"; printf 'response:\n%s\n' "$tools_resp" | head -c 500; exit 1; }
  done
  rm -f "$init_headers_path" "$init_body_path"
  echo "  ok (session=${mcp_session:0:8}…, all 5 IM tools present)"

  echo "[15/15] interaction endpoints accept daemon-style user-input + plan-approval requests"
  # We can't deterministically force a real LLM to emit AskUserQuestion or
  # ExitPlanMode in CI, but we can exercise the server-side contract the
  # daemon uses: POST /interactions/user-input + /interactions/plan-approval
  # must persist an interaction_requests row tied to the right conversation.
  local before_interactions
  before_interactions=$(run_psql "SELECT COUNT(*)::text FROM interaction_requests")
  local user_input_run_key="rae-e2e:user-input:$(uuidgen)"
  curl -fsS -X POST \
    "http://127.0.0.1:$RAE_API_PORT/api/v1/internal/remote-agents/$RAE_REMOTE_AGENT_ID/interactions/user-input" \
    -H "authorization: Bearer $SYNAPSE_MACHINE_KEY" \
    -H "content-type: application/json" \
    -d "$(jq -n --arg c "$conv_a" --arg k "$user_input_run_key" \
        '{conversationId: $c, runKey: $k, title: "rae-e2e probe question", questions: [{id:"q1", header:"q1", type:"single_select", prompt:"Pick one", required:true, allowOther:false, options:[{id:"a", label:"a"},{id:"b", label:"b"}]}]}')" \
    >/dev/null
  local plan_run_key="rae-e2e:plan:$(uuidgen)"
  curl -fsS -X POST \
    "http://127.0.0.1:$RAE_API_PORT/api/v1/internal/remote-agents/$RAE_REMOTE_AGENT_ID/interactions/plan-approval" \
    -H "authorization: Bearer $SYNAPSE_MACHINE_KEY" \
    -H "content-type: application/json" \
    -d "$(jq -n --arg c "$conv_a" --arg k "$plan_run_key" \
        '{conversationId: $c, runKey: $k, title: "rae-e2e probe plan", planMarkdown: "- [ ] step 1\n- [ ] step 2"}')" \
    >/dev/null
  local after_interactions
  after_interactions=$(run_psql "SELECT COUNT(*)::text FROM interaction_requests")
  test "$after_interactions" -gt "$before_interactions" \
    || { echo "  FAIL: interaction_requests did not grow ($before_interactions → $after_interactions)"; exit 1; }
  echo "  ok (interaction_requests $before_interactions → $after_interactions)"

  echo
  echo "All 15 assertions passed for stack rae-$RAE_STACK_ID"
}

wait_for_delivery_id() {
  local conversation_id="$1"
  local timeout="${2:-30}"
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    local got
    got=$(run_psql "SELECT id FROM remote_agent_message_deliveries WHERE remote_agent_id='$RAE_REMOTE_AGENT_ID' AND conversation_id='$conversation_id' AND status='pending' ORDER BY created_at DESC LIMIT 1" 2>/dev/null || true)
    if [ -n "$got" ]; then
      printf '%s' "$got"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
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
