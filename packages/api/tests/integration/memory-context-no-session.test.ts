// Regression test: writing a `participant_private` memory must NOT create
// a `sessions` row.
//
// The legacy memory path called `ensureConversationActorSessionContext`,
// which guarantees a `sessions` row alongside the
// `conversation_actor_contexts` row. After the external/API-session cleanup,
// memory goes through `ensureConversationActorContext` instead, which only
// upserts `conversation_actor_contexts`.
//
// This test pins that behavior so a future refactor can't silently regress
// the "memory creates a session as a side effect" mistake.
//
// **MUST be run via scripts/run-test.sh** — see comment in
// origin-propagation.test.ts for why.

if (
  !process.env.DATABASE_URL ||
  !process.env.DATABASE_URL.includes(":55433/")
) {
  throw new Error(
    "memory-context-no-session.test.ts must be run via packages/api/tests/integration/scripts/run-test.sh " +
      "(DATABASE_URL must point at the worktree-isolated test postgres on 127.0.0.1:55433)."
  )
}

import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import pg from "pg"

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

test("createMemory(participant_private) creates conversation_actor_contexts but NOT sessions", async () => {
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
    `INSERT INTO conversations (id, kind, boundary, internal_workspace_id, created_by_workspace_member_id)
     VALUES ($1, 'private', 'internal', $2, $3)`,
    [conversationId, seed.workspaceId, seed.workspaceMemberId]
  )

  // `requireActiveActorConversationParticipant` (called transitively by
  // both ensureConversationActorContext and assertActorInConversation)
  // joins conversation_participants to access_subjects on subject_id, so
  // we need an access_subjects row of kind='actor' first.
  const subjectRow = await client.query<{ id: string }>(
    `INSERT INTO access_subjects (kind, workspace_id, actor_id)
     VALUES ('actor', $1, $2)
     RETURNING id`,
    [seed.workspaceId, actorId]
  )
  const actorSubjectId = subjectRow.rows[0].id

  await client.query(
    `INSERT INTO conversation_participants
      (id, conversation_id, participant_type, subject_id, role_key, state)
     VALUES ($1, $2, 'actor', $3, 'member', 'active')`,
    [actorParticipantId, conversationId, actorSubjectId]
  )
  await client.query(
    `INSERT INTO conversation_participant_states
      (conversation_id, participant_id, read_watermark_sequence)
     VALUES ($1, $2, 0)
     ON CONFLICT DO NOTHING`,
    [conversationId, actorParticipantId]
  )

  // Sanity: no sessions or contexts exist for this pair before the
  // memory write.
  const preSessions = await client.query(
    "SELECT id FROM sessions WHERE conversation_id = $1 AND actor_id = $2",
    [conversationId, actorId]
  )
  assert.equal(preSessions.rowCount, 0, "no sessions row before memory write")
  const preContexts = await client.query(
    "SELECT id FROM conversation_actor_contexts WHERE conversation_id = $1 AND actor_id = $2",
    [conversationId, actorId]
  )
  assert.equal(
    preContexts.rowCount,
    0,
    "no conversation_actor_contexts row before memory write"
  )

  await createMemory(seed.workspaceId, {
    spaceType: "participant_private",
    actorId,
    conversationId,
    category: "fact",
    content: "memory regression: this write must not spawn a session row",
  })

  const postContexts = await client.query<{ id: string }>(
    "SELECT id FROM conversation_actor_contexts WHERE conversation_id = $1 AND actor_id = $2",
    [conversationId, actorId]
  )
  assert.equal(
    postContexts.rowCount,
    1,
    "conversation_actor_contexts row must exist after createMemory"
  )

  const postSessions = await client.query<{ id: string }>(
    "SELECT id FROM sessions WHERE conversation_id = $1 AND actor_id = $2",
    [conversationId, actorId]
  )
  assert.equal(
    postSessions.rowCount,
    0,
    "createMemory(participant_private) must NOT create a sessions row " +
      "(regression: legacy ensureConversationActorSessionContext path)"
  )
})
