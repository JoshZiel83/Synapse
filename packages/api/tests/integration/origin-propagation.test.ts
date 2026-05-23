// Integration test: ToolResultOrigin survives the full DB persistence
// round-trip via createToolResult → tool_results.metadata JSONB.
//
// **MUST be run via scripts/run-test.sh** (not bare `node --test`) — Node's
// ESM static imports load before any top-of-file `process.env = ...` runs,
// so by the time we'd set DATABASE_URL/REDIS_URL the redis client and
// pg pool in transitively-imported modules have already grabbed defaults
// (production redis on :6379, default DB URL). The wrapper script sets
// these in the parent process before invoking node.
//
// Run:
//   bash packages/api/tests/integration/scripts/up.sh
//   bash packages/api/tests/integration/scripts/run-test.sh \
//     packages/api/tests/integration/origin-propagation.test.ts

// Fail fast if someone runs us via plain `node --test` — the dependent
// modules have already opened the wrong connections at this point, and the
// error message you'd otherwise see ("password authentication failed for
// user 'synapse'" + redis NOAUTH spam) is misleading.
if (
  !process.env.DATABASE_URL ||
  !process.env.DATABASE_URL.includes(":55433/")
) {
  throw new Error(
    "origin-propagation.test.ts must be run via packages/api/tests/integration/scripts/run-test.sh " +
      "(DATABASE_URL must point at the worktree-isolated test postgres on 127.0.0.1:55433). " +
      "Direct `node --test` invocation does not work because ESM static imports load " +
      "config/redis/pg modules before any top-of-file env assignment can take effect."
  )
}

import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { v4 as uuidv4 } from "uuid"
import pg from "pg"

import { createToolResult } from "../../src/modules/execution/service.js"

import {
  resetDb,
  seedMinimal,
  TEST_PG_HOST,
  TEST_PG_PORT,
  TEST_PG_USER,
  TEST_PG_PASSWORD,
  TEST_PG_DB,
  type MinimalSeed,
} from "./harness/index.js"

let seed: MinimalSeed | undefined
let client: pg.Client | undefined

before(async () => {
  await resetDb()
  seed = await seedMinimal({ workspaceSlugSuffix: "origin" })
  client = new pg.Client({
    host: TEST_PG_HOST,
    port: TEST_PG_PORT,
    user: TEST_PG_USER,
    password: TEST_PG_PASSWORD,
    database: TEST_PG_DB,
  })
  await client.connect()
})

after(async () => {
  if (client) await client.end()
})

// Set up minimal session+turn+conversation+tool_call rows so we can write
// to tool_results without going through the full actor pipeline.
async function buildToolCall(opts: {
  toolKind: "callable" | "mcp_plugin" | "mcp_relay" | "builtin"
  toolName: string
}): Promise<string> {
  if (!seed || !client) throw new Error("test fixtures missing")
  const conversationId = uuidv4()
  const sessionId = uuidv4()
  const turnId = uuidv4()
  const toolCallId = uuidv4()

  // We need an actor for the session to satisfy NOT NULL constraints —
  // seed an inline actor row directly.
  const actorRow = await client.query<{ id: string }>(
    `INSERT INTO actors (workspace_id, name, role, title)
     VALUES ($1, 'OriginTest Actor', 'assistant', 'OriginTest Title')
     RETURNING id`,
    [seed.workspaceId]
  )
  const actorId = actorRow.rows[0].id

  await client.query(
    `INSERT INTO conversations (id, kind, boundary, internal_workspace_id, created_by_workspace_member_id)
     VALUES ($1, 'private', 'internal', $2, $3)`,
    [conversationId, seed.workspaceId, seed.workspaceMemberId]
  )

  await client.query(
    `INSERT INTO sessions (id, workspace_id, actor_id, conversation_id, channel_type, status)
     VALUES ($1, $2, $3, $4, 'web', 'idle')`,
    [sessionId, seed.workspaceId, actorId, conversationId]
  )

  await client.query(
    `INSERT INTO turns (id, session_id, actor_id, conversation_id, trigger_type, status)
     VALUES ($1, $2, $3, $4, 'user_message', 'running')`,
    [turnId, sessionId, actorId, conversationId]
  )

  await client.query(
    `INSERT INTO tool_calls (
       id, turn_id, conversation_id, session_id,
       bundle_id, tool_kind, tool_name, normalized_input
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, '{}')`,
    [
      toolCallId,
      turnId,
      conversationId,
      sessionId,
      uuidv4(),
      opts.toolKind,
      opts.toolName,
    ]
  )

  return toolCallId
}

test("MCP path: createToolResult persists origin into tool_results.metadata JSONB", async () => {
  if (!client || !seed) throw new Error("fixtures missing")

  const toolCallId = await buildToolCall({
    toolKind: "mcp_plugin",
    toolName: "filesystem__View",
  })

  await createToolResult({
    toolCallId,
    parts: [{ type: "text", text: "hello mcp" }],
    metadata: {
      toolCallId: "call-1",
      toolName: "filesystem__View",
      origin: {
        kind: "mcp_relay",
        deviceId: "dev-mcp-1",
        exposureStableKey: "synapse.builtin.filesystem.v1",
        runtimeSessionId: "rs-1",
      },
      structuredContent: { entries: 12 },
      isError: false,
    },
  })

  const rows = await client.query<{ metadata: any; is_error: boolean }>(
    "SELECT metadata, is_error FROM tool_results WHERE tool_call_id = $1",
    [toolCallId]
  )
  assert.equal(rows.rows.length, 1)
  const meta = rows.rows[0].metadata
  assert.equal(meta.origin.kind, "mcp_relay")
  assert.equal(meta.origin.deviceId, "dev-mcp-1")
  assert.equal(meta.origin.exposureStableKey, "synapse.builtin.filesystem.v1")
  assert.deepEqual(meta.structuredContent, { entries: 12 })
})

test("Callable path: createToolResult persists synthesized builtin origin", async () => {
  if (!client || !seed) throw new Error("fixtures missing")

  const toolCallId = await buildToolCall({
    toolKind: "callable",
    toolName: "create_memory",
  })

  // This is the metadata shape that ai/index.ts:1242 (after Phase 7b) writes
  // for callable ToolPlugin results.
  await createToolResult({
    toolCallId,
    parts: [{ type: "text", text: "memory saved" }],
    metadata: {
      origin: { kind: "builtin", toolKind: "create_memory" },
      toolCallId: "call-2",
      toolName: "create_memory",
      isError: false,
    },
  })

  const rows = await client.query<{ metadata: any }>(
    "SELECT metadata FROM tool_results WHERE tool_call_id = $1",
    [toolCallId]
  )
  assert.equal(rows.rows.length, 1)
  const meta = rows.rows[0].metadata
  assert.equal(meta.origin.kind, "builtin")
  assert.equal(meta.origin.toolKind, "create_memory")
  assert.equal(meta.toolName, "create_memory")
})

test("Origin survives all 5 ToolResultOrigin kinds through the JSONB column", async () => {
  if (!client || !seed) throw new Error("fixtures missing")

  const kinds = [
    { kind: "mcp_remote", serverKey: "github" },
    {
      kind: "mcp_relay",
      deviceId: "dev-x",
      exposureStableKey: "syn.builtin.cua.v1",
    },
    { kind: "callable_plugin", pluginKey: "amap/openapi" },
    { kind: "builtin", toolKind: "sleep" },
    { kind: "model_response", providerType: "anthropic" },
  ]

  for (const origin of kinds) {
    const toolCallId = await buildToolCall({
      toolKind: "mcp_plugin",
      toolName: `probe_${origin.kind}`,
    })
    await createToolResult({
      toolCallId,
      parts: [{ type: "text", text: `probe ${origin.kind}` }],
      metadata: { origin },
    })
    const rows = await client.query<{ metadata: any }>(
      "SELECT metadata FROM tool_results WHERE tool_call_id = $1",
      [toolCallId]
    )
    assert.deepEqual(
      rows.rows[0].metadata.origin,
      origin,
      `origin round-trip failed for kind=${origin.kind}`
    )
  }
})

test("Failure path: origin persisted into tool_results.metadata even when isError=true", async () => {
  // Mirrors the shape that ai/index.ts:appendMcpFailureResult writes after
  // Phase 9 — verifying that origin doesn't get dropped on the way through
  // the failure branch (previous bug: origin was only on success path).
  if (!client || !seed) throw new Error("fixtures missing")
  const toolCallId = await buildToolCall({
    toolKind: "mcp_plugin",
    toolName: "github__find_issue",
  })
  await createToolResult({
    toolCallId,
    isError: true,
    errorMessage: "GitHub returned 503 — service unavailable",
    parts: [
      { type: "text", text: "GitHub returned 503 — service unavailable" },
    ],
    metadata: {
      // shape produced by appendMcpFailureResult post Phase 9:
      toolCallId: "call-fail-1",
      toolName: "github__find_issue",
      isError: true,
      origin: { kind: "mcp_remote", serverKey: "github/openapi" },
      errorCode: "upstream_unavailable",
    },
  })

  const rows = await client.query<{ metadata: any; is_error: boolean }>(
    "SELECT metadata, is_error FROM tool_results WHERE tool_call_id = $1",
    [toolCallId]
  )
  assert.equal(rows.rows.length, 1)
  assert.equal(rows.rows[0].is_error, true)
  const meta = rows.rows[0].metadata
  assert.equal(meta.origin.kind, "mcp_remote")
  assert.equal(meta.origin.serverKey, "github/openapi")
  assert.equal(meta.isError, true)
  assert.equal(meta.errorCode, "upstream_unavailable")
})
