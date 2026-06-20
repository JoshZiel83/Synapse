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
if (process.env.SYNAPSE_INT_TEST !== "1") {
  throw new Error(
    "origin-propagation.test.ts must be run via packages/api/tests/integration/scripts/run-test.sh " +
      "(it sets SYNAPSE_INT_TEST=1 plus the per-worktree DATABASE_URL/REDIS_URL). " +
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
  teardownApiConnections,
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
  // Phase 10: close the pg pool and redis sockets that
  // execution/service.js opened transitively on import. Without this,
  // the test process hangs after the last test finishes.
  await teardownApiConnections()
})

// Set up minimal session+turn+conversation+tool_call rows so we can write
// to tool_results without going through the full actor pipeline.
async function buildToolCall(opts: {
  sourceKind: "system" | "plugin" | "device"
  toolName: string
}): Promise<string> {
  if (!seed || !client) throw new Error("test fixtures missing")
  const conversationId = uuidv4()
  const sessionId = uuidv4()
  const turnId = uuidv4()
  const toolCallId = uuidv4()
  // Tool provenance & routing: tool_calls requires source_kind + source_snapshot
  // (NOT NULL, CHECK-consistent).
  const sourceSnapshot = (() => {
    switch (opts.sourceKind) {
      case "device":
        return {
          kind: "device",
          deviceToolId: uuidv4(),
          exposureStableKey: "synapse.builtin.filesystem.v1",
        }
      case "plugin":
        return {
          kind: "plugin",
          installationId: uuidv4(),
          upstreamToolName: opts.toolName,
        }
      default:
        return { kind: "system", registryKey: opts.toolName }
    }
  })()

  // We need an actor for the session to satisfy NOT NULL constraints —
  // seed an inline actor row directly.
  const actorId = uuidv4()
  await client.query("BEGIN")
  try {
    await client.query(
      `INSERT INTO workspace_resources (id, workspace_id, kind, display_name, owner_subject_id, created_by_subject_id, status)
       VALUES ($1, $2, 'actor', 'OriginTest Actor', $3, $3, 'active')`,
      [actorId, seed.workspaceId, seed.memberSubjectId]
    )
    await client.query(
      `INSERT INTO actors (id, role, title)
       VALUES ($1, 'assistant', 'OriginTest Title')`,
      [actorId]
    )
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  }

  await client.query(
    `INSERT INTO conversations (id, kind, workspace_id, created_by_workspace_member_id)
     VALUES ($1, 'direct', $2, $3)`,
    [conversationId, seed.workspaceId, seed.workspaceMemberId]
  )

  await client.query(
    `INSERT INTO sessions (id, workspace_id, actor_id, conversation_id, status)
     VALUES ($1, $2, $3, $4, 'idle')`,
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
       bundle_id, tool_name, source_kind, source_snapshot, normalized_input
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}')`,
    [
      toolCallId,
      turnId,
      conversationId,
      sessionId,
      uuidv4(),
      opts.toolName,
      opts.sourceKind,
      JSON.stringify(sourceSnapshot),
    ]
  )

  return toolCallId
}

test("Device path: createToolResult persists origin into tool_results.metadata JSONB", async () => {
  if (!client || !seed) throw new Error("fixtures missing")

  const toolCallId = await buildToolCall({
    sourceKind: "device",
    toolName: "filesystem__View",
  })

  await createToolResult({
    toolCallId,
    parts: [{ type: "text", text: "hello mcp" }],
    metadata: {
      toolCallId: "call-1",
      toolName: "filesystem__View",
      origin: {
        kind: "device",
        deviceToolId: "dev-mcp-1",
        exposureStableKey: "synapse.builtin.filesystem.v1",
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
  assert.equal(meta.origin.kind, "device")
  assert.equal(meta.origin.deviceToolId, "dev-mcp-1")
  assert.equal(meta.origin.exposureStableKey, "synapse.builtin.filesystem.v1")
  assert.deepEqual(meta.structuredContent, { entries: 12 })
})

test("System path: createToolResult persists synthesized system origin", async () => {
  if (!client || !seed) throw new Error("fixtures missing")

  const toolCallId = await buildToolCall({
    sourceKind: "system",
    toolName: "create_memory",
  })

  // This is the metadata shape that ai/index.ts writes for local system-tool
  // results.
  await createToolResult({
    toolCallId,
    parts: [{ type: "text", text: "memory saved" }],
    metadata: {
      origin: { kind: "system", registryKey: "create_memory" },
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
  assert.equal(meta.origin.kind, "system")
  assert.equal(meta.origin.registryKey, "create_memory")
  assert.equal(meta.toolName, "create_memory")
})

test("Origin survives all 5 ToolResultOrigin kinds through the JSONB column", async () => {
  if (!client || !seed) throw new Error("fixtures missing")

  const kinds = [
    { kind: "system", registryKey: "sleep" },
    {
      kind: "plugin",
      installationId: uuidv4(),
      upstreamToolName: "github_search",
    },
    {
      kind: "device",
      deviceToolId: "dev-x",
      exposureStableKey: "syn.builtin.cua.v1",
    },
    { kind: "provider_native", providerType: "openai", toolName: "web_search" },
    { kind: "model_response", providerType: "anthropic" },
  ]

  for (const origin of kinds) {
    const mappedSourceKind = origin.kind === "plugin" ? "plugin" : "system"
    const toolCallId = await buildToolCall({
      sourceKind: origin.kind === "device" ? "device" : mappedSourceKind,
      toolName: `probe_${origin.kind}`,
    })
    await createToolResult({
      toolCallId,
      parts: [{ type: "text", text: `probe ${origin.kind}` }],
      metadata: { origin },
    })
    const rows: pg.QueryResult<{ metadata: any }> = await client.query(
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
    sourceKind: "plugin",
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
      origin: {
        kind: "plugin",
        installationId: uuidv4(),
        upstreamToolName: "github__find_issue",
        publisherSlug: "github",
        itemSlug: "openapi",
      },
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
  assert.equal(meta.origin.kind, "plugin")
  assert.equal(meta.origin.publisherSlug, "github")
  assert.equal(meta.origin.itemSlug, "openapi")
  assert.equal(meta.isError, true)
  assert.equal(meta.errorCode, "upstream_unavailable")
})
