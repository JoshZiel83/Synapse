// Integration test: loadExecutionToolResultsForSession reads
// tool_calls / tool_results / tool_result_parts and rehydrates
// CanonicalToolResult; buildSessionContextItems(...executionToolResults)
// then uses the result as authoritative source over session_message.metadata.
//
// Run via: bash packages/api/tests/integration/scripts/run-test.sh
//   packages/api/tests/integration/execution-tool-results.test.ts

if (process.env.SYNAPSE_INT_TEST !== "1") {
  throw new Error(
    "execution-tool-results.test.ts must be run via packages/api/tests/integration/scripts/run-test.sh"
  )
}

import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { v4 as uuidv4 } from "uuid"
import pg from "pg"

import { createToolResult } from "../../src/modules/execution/service.js"
import {
  buildSessionContextItems,
  loadExecutionToolResultsForSession,
} from "../../src/modules/ai/context-builder.js"
import { extractText, textBlocks } from "@synapse/shared"

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
  seed = await seedMinimal({ workspaceSlugSuffix: "exec-tr" })
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
  await teardownApiConnections()
})

async function buildFixture(opts: {
  toolName: string
  providerCallId?: string
  sourceKind?: "plugin" | "device" | "system"
}): Promise<{
  sessionId: string
  toolCallId: string
  providerCallId: string
}> {
  if (!seed || !client) throw new Error("fixtures missing")
  const conversationId = uuidv4()
  const sessionId = uuidv4()
  const turnId = uuidv4()
  const toolCallId = uuidv4()
  const providerCallId =
    opts.providerCallId || `toolu_${uuidv4().replace(/-/g, "").slice(0, 16)}`
  const sourceKind = opts.sourceKind || "plugin"
  const sourceSnapshot =
    sourceKind === "device"
      ? {
          kind: "device",
          deviceToolId: "dev-abc",
          exposureStableKey: "synapse.builtin.filesystem.v1",
        }
      : sourceKind === "system"
        ? { kind: "system", registryKey: opts.toolName }
        : {
            kind: "plugin",
            installationId: uuidv4(),
            upstreamToolName: opts.toolName,
          }

  const actorRow = await client.query<{ id: string }>(
    `INSERT INTO actors (workspace_id, name, role, title)
     VALUES ($1, 'ExecTR Actor', 'assistant', 'ExecTR Title') RETURNING id`,
    [seed.workspaceId]
  )
  const actorId = actorRow.rows[0].id

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
       provider_call_id, bundle_id, tool_name,
       source_kind, source_snapshot, normalized_input
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}')`,
    [
      toolCallId,
      turnId,
      conversationId,
      sessionId,
      providerCallId,
      uuidv4(),
      opts.toolName,
      sourceKind,
      JSON.stringify(sourceSnapshot),
    ]
  )

  return { sessionId, toolCallId, providerCallId }
}

test("loadExecutionToolResultsForSession returns rehydrated CanonicalToolResult keyed by provider_call_id", async () => {
  const { sessionId, toolCallId, providerCallId } = await buildFixture({
    toolName: "filesystem__View",
    sourceKind: "device",
  })

  // Write a tool_results row with origin / structuredContent / inner metadata
  // — matches the Phase 7b writer shape (everything flat in metadata JSONB).
  await createToolResult({
    toolCallId,
    parts: [{ type: "text", text: "file contents: hello world" }],
    metadata: {
      toolCallId: providerCallId,
      toolName: "filesystem__View",
      providerCallId,
      origin: {
        kind: "device",
        deviceToolId: "dev-abc",
        exposureStableKey: "synapse.builtin.filesystem.v1",
      },
      structuredContent: { lines: 1, path: "/tmp/x" },
      isError: false,
      latencyMs: 123,
      traceId: "trc-deadbeef",
    },
  })

  const map = await loadExecutionToolResultsForSession(sessionId)
  // indexed by BOTH provider_call_id and the DB row id
  const byProviderId = map.get(providerCallId)
  const byDbId = map.get(toolCallId)
  assert.ok(byProviderId, "should be indexed by provider_call_id")
  assert.ok(byDbId, "should also be indexed by tool_calls.id")
  // Both should point to the same authoritative result
  assert.equal(byProviderId, byDbId, "same object instance for both keys")

  assert.equal(byProviderId!.toolName, "filesystem__View")
  assert.equal(byProviderId!.toolCallId, providerCallId)
  assert.equal(byProviderId!.providerCallId, providerCallId)
  assert.equal(byProviderId!.isError, false)
  assert.equal(byProviderId!.origin.kind, "device")
  assert.deepEqual(byProviderId!.structuredContent, {
    lines: 1,
    path: "/tmp/x",
  })
  // residual metadata (non-reserved keys) survives
  assert.equal((byProviderId!.metadata as any).latencyMs, 123)
  assert.equal((byProviderId!.metadata as any).traceId, "trc-deadbeef")
  // canonical content rehydrated from tool_result_parts
  assert.equal(byProviderId!.content.length, 1)
  assert.equal(extractText(byProviderId!.content), "file contents: hello world")
})

test("buildSessionContextItems uses execution map over stale metadata projection", async () => {
  const { sessionId, providerCallId } = await buildFixture({
    toolName: "real_tool_name",
  })
  // Write authoritative execution data
  await createToolResult({
    toolCallId: (
      await client!.query<{ id: string }>(
        "SELECT id FROM tool_calls WHERE session_id = $1 AND provider_call_id = $2",
        [sessionId, providerCallId]
      )
    ).rows[0].id,
    parts: [{ type: "text", text: "AUTHORITATIVE content from tables" }],
    metadata: {
      toolCallId: providerCallId,
      toolName: "real_tool_name",
      providerCallId,
      origin: {
        kind: "plugin",
        installationId: uuidv4(),
        upstreamToolName: "real_tool_name",
      },
      isError: false,
    },
  })

  const executionMap = await loadExecutionToolResultsForSession(sessionId)

  // Now build context with a session_message that has DIFFERENT (stale)
  // metadata — the execution map should still win.
  const items = buildSessionContextItems(
    [
      {
        id: "msg-stale",
        sessionId,
        role: "tool_result",
        contentBlocks: textBlocks("stale projection content"),
        metadata: {
          toolCallId: providerCallId,
          toolName: "stale_wrong_name",
          origin: {
            kind: "system",
            registryKey: "stale_wrong_name",
          },
        },
      },
    ],
    { executionToolResults: executionMap }
  )

  const tr = (items[0] as any).toolResults[0]
  assert.equal(tr.toolName, "real_tool_name", "tool_calls.tool_name wins")
  assert.equal(
    tr.origin.kind,
    "plugin",
    "tool_results.metadata.origin wins"
  )
  assert.equal(extractText(tr.content), "AUTHORITATIVE content from tables")
})

test("loadExecutionToolResultsForSession returns empty map for unknown session", async () => {
  const map = await loadExecutionToolResultsForSession(
    "00000000-0000-4000-8000-000000000000"
  )
  assert.equal(map.size, 0)
})
