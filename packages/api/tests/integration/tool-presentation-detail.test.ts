// Integration test (Phase 6 gate): buildToolActivityDetail renders friendly
// presentation (icon + ICU title + result summary), NOT raw JSON, and the deep
// secretlint pass scrubs secrets from every rendered string before the snapshot.
//
// Run via: bash packages/api/tests/integration/scripts/run-test.sh
//   packages/api/tests/integration/tool-presentation-detail.test.ts

if (process.env.SYNAPSE_INT_TEST !== "1") {
  throw new Error(
    "tool-presentation-detail.test.ts must be run via packages/api/tests/integration/scripts/run-test.sh"
  )
}

import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { v4 as uuidv4 } from "uuid"
import pg from "pg"

import { createToolResult } from "../../src/modules/execution/service.js"
import { getSessionRuntimeTurnActivityDetail } from "../../src/modules/session/runtime.js"
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
  seed = await seedMinimal({ workspaceSlugSuffix: "tp-detail" })
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

async function buildDeviceFixture(opts: {
  visibleToolName: string
  exposureStableKey: string
  normalizedInput: unknown
}) {
  if (!seed || !client) throw new Error("fixtures missing")
  const conversationId = uuidv4()
  const sessionId = uuidv4()
  const turnId = uuidv4()
  const toolCallId = uuidv4()

  const actorId = uuidv4()
  await client.query("BEGIN")
  try {
    await client.query(
      `INSERT INTO workspace_resources (id, workspace_id, kind, display_name, owner_subject_id, created_by_subject_id, status)
       VALUES ($1, $2, 'actor', 'TP Actor', $3, $3, 'active')`,
      [actorId, seed.workspaceId, seed.memberSubjectId]
    )
    await client.query(
      `INSERT INTO actors (id, role, title)
       VALUES ($1, 'assistant', 'TP Title')`,
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
  const stableKey = `${opts.exposureStableKey}/${opts.visibleToolName}`
  await client.query(
    `INSERT INTO tool_calls (
       id, turn_id, conversation_id, session_id,
       bundle_id, tool_name, status,
       source_kind, source_snapshot, normalized_input
     ) VALUES ($1, $2, $3, $4, $5, $6, 'completed', 'runtime', $7, $8)`,
    [
      toolCallId,
      turnId,
      conversationId,
      sessionId,
      uuidv4(),
      opts.visibleToolName,
      JSON.stringify({
        kind: "runtime",
        runtimeToolId: uuidv4(),
        exposureStableKey: opts.exposureStableKey,
        runtimeName: "laptop",
        visibleToolName: opts.visibleToolName,
        stableKey,
      }),
      JSON.stringify(opts.normalizedInput),
    ]
  )
  return { conversationId, sessionId, turnId, actorId, toolCallId }
}

test("fs_edit renders friendly title + diff + result summary (not raw JSON)", async () => {
  const fx = await buildDeviceFixture({
    visibleToolName: "fs_edit",
    exposureStableKey: "builtin/filesystem",
    normalizedInput: {
      path: "/home/user/project/foo.ts",
      edits: [{ old_string: "hello", new_string: "world" }],
    },
  })
  // Result with Phase-2 toolMeta carrying bytes_written + edits_applied.
  await createToolResult({
    toolCallId: fx.toolCallId,
    parts: [
      {
        type: "text",
        text: JSON.stringify({
          path: "/home/user/project/foo.ts",
          bytes_written: 320,
        }),
      },
    ],
    metadata: {
      toolCallId: fx.toolCallId,
      toolName: "fs_edit",
      toolMeta: { bytes_written: 320, edits_applied: 1 },
    },
  })

  const detail = await getSessionRuntimeTurnActivityDetail({
    conversationId: fx.conversationId,
    actorId: fx.actorId,
    turnId: fx.turnId,
  })
  assert.ok(detail, "detail should exist")
  const item = detail!.items.find((i) => i.toolCallId === fx.toolCallId)
  assert.ok(item, "fs_edit item present")
  assert.equal(item!.icon, "file-pen")
  assert.equal(item!.displayTitle, "正在编辑 foo.ts")
  assert.equal(item!.titlePresentation?.key, "tool.fs.edit.title")
  assert.equal(item!.resultSummary?.fallback, "已写入 320 字节, 1 处生效")
  // diff request block shows +/- not a raw JSON dump
  const reqText = item!.requestBlocks
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n")
  assert.match(reqText, /- hello/)
  assert.match(reqText, /\+ world/)
  // source badge from snapshot
  assert.equal(item!.source?.kind, "device")
})

test("no-leak: a Bearer token in a bash command never reaches the rendered blocks", async () => {
  const token = "ghp_1234567890abcdefABCDEF1234567890abcd" // gitleaks:allow
  const fx = await buildDeviceFixture({
    visibleToolName: "bash",
    exposureStableKey: "builtin/commandline",
    normalizedInput: {
      command: `curl -H "Authorization: Bearer ${token}" https://x`,
    },
  })
  await createToolResult({
    toolCallId: fx.toolCallId,
    parts: [{ type: "text", text: "ok" }],
    metadata: {
      toolCallId: fx.toolCallId,
      toolName: "bash",
      toolMeta: { exit_code: 0 },
    },
  })

  const detail = await getSessionRuntimeTurnActivityDetail({
    conversationId: fx.conversationId,
    actorId: fx.actorId,
    turnId: fx.turnId,
  })
  const item = detail!.items.find((i) => i.toolCallId === fx.toolCallId)
  assert.ok(item)
  const allText = JSON.stringify(item)
  assert.ok(
    !allText.includes(token),
    "GitHub token must be redacted from the rendered detail"
  )
  assert.ok(!allText.includes("Bearer ghp_"), "Bearer token must be redacted")
  assert.equal(item!.resultSummary?.fallback, "退出码 0")
})

test("unknown device tool falls back to generic (title = stableKey leaf)", async () => {
  const fx = await buildDeviceFixture({
    visibleToolName: "not_a_real_tool",
    exposureStableKey: "builtin/filesystem",
    normalizedInput: { foo: 1 },
  })
  await createToolResult({
    toolCallId: fx.toolCallId,
    parts: [{ type: "text", text: "x" }],
    metadata: { toolCallId: fx.toolCallId, toolName: "not_a_real_tool" },
  })
  const detail = await getSessionRuntimeTurnActivityDetail({
    conversationId: fx.conversationId,
    actorId: fx.actorId,
    turnId: fx.turnId,
  })
  const item = detail!.items.find((i) => i.toolCallId === fx.toolCallId)
  assert.ok(item)
  assert.equal(item!.icon, "wrench")
  assert.equal(item!.displayTitle, "not_a_real_tool")
})
