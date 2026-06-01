// Regression test: writing a memory must NOT create a `sessions` row.
//
// The legacy memory path called `ensureConversationActorSessionContext`,
// which guarantees a `sessions` row alongside the
// `conversation_actor_contexts` row. After the external/API-session cleanup
// and the D4 subject-scope refactor, memory no longer touches sessions OR
// conversation_actor_contexts — memory_spaces is keyed by
// (owner_subject_id, scope_subject_id?, namespace_key) directly.
//
// This test pins that behavior so a future refactor can't silently regress
// the "memory creates a session as a side effect" mistake.
//
// **MUST be run via scripts/run-test.sh** — see comment in
// origin-propagation.test.ts for why.

if (process.env.SYNAPSE_INT_TEST !== "1") {
  throw new Error(
    "memory-context-no-session.test.ts must be run via packages/api/tests/integration/scripts/run-test.sh " +
      "(it sets SYNAPSE_INT_TEST=1 plus the per-worktree DATABASE_URL/REDIS_URL)."
  )
}

import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import pg from "pg"
import { SUBJECT_KIND } from "@synapse/shared"

import { createMemory } from "../../src/modules/memory/service.js"

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
  seed = await seedMinimal({ workspaceSlugSuffix: "mem-no-session" })
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

test("createMemory(owner=actor + scope=conversation) does NOT create a sessions row", async () => {
  if (!seed || !client) throw new Error("test fixtures missing")

  const conversationId = randomUUID()
  const actorId = randomUUID()
  const actorParticipantId = randomUUID()

  await client.query(
    `INSERT INTO actors (id, workspace_id, name, role, title)
     VALUES ($1, $2, 'mem-no-session-actor', 'assistant', 'tester')`,
    [actorId, seed.workspaceId]
  )

  await client.query(
    `INSERT INTO conversations (id, kind, workspace_id, created_by_workspace_member_id)
     VALUES ($1, 'direct', $2, $3)`,
    [conversationId, seed.workspaceId, seed.workspaceMemberId]
  )

  const subjectRow = await client.query<{ id: string }>(
    `INSERT INTO access_subjects (kind, workspace_id, actor_id)
     VALUES ('actor', $1, $2)
     RETURNING id`,
    [seed.workspaceId, actorId]
  )
  const actorSubjectId = subjectRow.rows[0].id

  await client.query(
    `INSERT INTO conversation_participants
      (id, conversation_id, subject_id, role_key, state)
     VALUES ($1, $2, $3, 'member', 'active')`,
    [actorParticipantId, conversationId, actorSubjectId]
  )
  await client.query(
    `INSERT INTO conversation_participant_states
      (conversation_id, participant_id, read_watermark_sequence)
     VALUES ($1, $2, 0)
     ON CONFLICT DO NOTHING`,
    [conversationId, actorParticipantId]
  )

  // Sanity: no sessions row before the memory write.
  const preSessions = await client.query(
    "SELECT id FROM sessions WHERE conversation_id = $1 AND actor_id = $2",
    [conversationId, actorId]
  )
  assert.equal(preSessions.rowCount, 0, "no sessions row before memory write")

  await createMemory(seed.workspaceId, {
    owner: { kind: SUBJECT_KIND.ACTOR, actorId },
    scope: { kind: SUBJECT_KIND.CONVERSATION, conversationId },
    category: "fact",
    content: "memory regression: this write must not spawn a session row",
  })

  const postSessions = await client.query<{ id: string }>(
    "SELECT id FROM sessions WHERE conversation_id = $1 AND actor_id = $2",
    [conversationId, actorId]
  )
  assert.equal(
    postSessions.rowCount,
    0,
    "createMemory must NOT create a sessions row " +
      "(regression: legacy ensureConversationActorSessionContext path)"
  )
})
