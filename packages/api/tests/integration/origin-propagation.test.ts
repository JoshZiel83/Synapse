// Integration test: ToolResultOrigin survives the full DB persistence
// round-trip via createToolResult → tool_results.metadata JSONB.
//
// This is the "are we actually persisting origin?" check for both the
// MCP path (where the metadata is constructed in ai/index.ts:1401) and
// the callable path (constructed in ai/index.ts:1242).
//
// Prerequisites: bash packages/api/tests/integration/scripts/up.sh

// Pin REDIS_URL + DATABASE_URL to the test stack BEFORE importing any API
// module that opens those connections at import time. Otherwise importing
// `execution/service.js` triggers the default redis client to spam NOAUTH
// against the production redis on :6379.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://synapse:test_password@127.0.0.1:55433/synapse_test"
process.env.REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:56380"

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
