/**
 * S19: deep test for retryAssistantMessage().
 *
 * Constructs the full prerequisites (actor + actor-participant + session +
 * model_error_notice item) via direct DB INSERTs from the test process,
 * then calls POST /chat/conversations/:cid/messages/:itemId/retry and
 * asserts:
 *   a) response is 200 with { retryEnqueued, sessionId, actorId }
 *   b) a session_wakeups row was created with source_participant_type =
 *      "workspace_member" and source_participant_id = workspace_members.id
 *      (S19 regression: previously this was incorrectly set to the
 *      assistant participant.id with type="workspace_member" — a mismatch
 *      that broke the model-error fallout in session-thinking.ts)
 *
 * Must be run via tests/integration/scripts/run-test.sh.
 */

if (process.env.SYNAPSE_INT_TEST !== "1") {
  throw new Error(
    "retry-deep.test.ts must be run via packages/api/tests/integration/scripts/run-test.sh"
  )
}

import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { Client } from "pg"
import {
  setupChatStack,
  teardownChatStack,
  registerTestUser,
  createTestWorkspace,
  TEST_PG_DB,
  TEST_PG_HOST,
  TEST_PG_PASSWORD,
  TEST_PG_PORT,
  TEST_PG_USER,
  type ChatStack,
} from "./harness/index.js"

const uuid = () =>
  ([8, 4, 4, 4, 12] as const)
    .map((len) => randomBytes(len / 2).toString("hex"))
    .join("-")

let stack: ChatStack | undefined

before(async () => {
  stack = await setupChatStack()
})

after(async () => {
  if (stack) await teardownChatStack(stack)
})

test("retry succeeds end-to-end and enqueues a session_wakeup with the correct workspace_member source", async () => {
  const ctx = await registerTestUser(stack!.baseClient)
  const ws = await createTestWorkspace(ctx.client)
  const bootstrap = await ctx.client.json<{
    workspaceMemberId: string
  }>(`/workspaces/${ws.id}/chat/bootstrap`)
  const workspaceMemberId = bootstrap.workspaceMemberId

  // Create a group conversation for the test workspace.
  const created = await ctx.client.json<{
    conversation: { conversationId: string }
  }>(`/workspaces/${ws.id}/chat/conversations`, {
    method: "POST",
    json: {
      clientRequestId: uuid(),
      kind: "group",
      title: "retry-deep-test",
      workspaceMemberIds: [],
    },
  })
  const conversationId = created.conversation.conversationId

  const pg = new Client({
    host: TEST_PG_HOST,
    port: TEST_PG_PORT,
    user: TEST_PG_USER,
    password: TEST_PG_PASSWORD,
    database: TEST_PG_DB,
  })
  await pg.connect()
  try {
    // Inject an actor in this workspace and add it as a participant in the
    // conversation. Insert a session bound to (actor, conversation) and a
    // model_error_notice item whose metadata.retrySessionId points at it.
    const actorId = randomUUID()
    const actorParticipantId = randomUUID()
    const sessionId = randomUUID()
    const itemId = randomUUID()

    await pg.query(
      `INSERT INTO actors (id, workspace_id, name, role, title)
       VALUES ($1, $2, 'retry-test-actor', 'assistant', 'tester')`,
      [actorId, ws.id]
    )
    // P1b: conversation_participants.subject_id is a polymorphic FK into
    // access_subjects (one row per logical subject — actor/member/etc.).
    // The conversation-participants insert below needs a matching
    // kind='actor' subject row, so create it first.
    const subjectRow = await pg.query<{ id: string }>(
      `INSERT INTO access_subjects (kind, workspace_id, actor_id)
       VALUES ('actor', $1, $2)
       RETURNING id`,
      [ws.id, actorId]
    )
    const actorSubjectId = subjectRow.rows[0].id
    await pg.query(
      `INSERT INTO conversation_participants
        (id, conversation_id, subject_id, role_key, state)
       VALUES ($1, $2, $3, 'member', 'active')`,
      [actorParticipantId, conversationId, actorSubjectId]
    )
    await pg.query(
      `INSERT INTO conversation_participant_states
        (conversation_id, participant_id, read_watermark_sequence)
       VALUES ($1, $2, 0)
       ON CONFLICT DO NOTHING`,
      [conversationId, actorParticipantId]
    )
    await pg.query(
      `INSERT INTO sessions (id, workspace_id, actor_id, conversation_id, status)
       VALUES ($1, $2, $3, $4, 'blocked')`,
      [sessionId, ws.id, actorId, conversationId]
    )
    // The error item is shared+visible, role=assistant, subtype=model_error_notice,
    // metadata carries retrySessionId so retryAssistantMessage can pick it up.
    // sequence is auto-assigned via IDENTITY; content lives in
    // conversation_item_parts (not required for the retry path which only
    // reads metadata).
    await pg.query(
      `INSERT INTO conversation_items
        (id, conversation_id, session_id, scope, surface, item_type, subtype,
         role, author_participant_id, metadata)
       VALUES ($1, $2, $3, 'shared', 'visible', 'message', 'model_error_notice',
         'assistant', $4, $5::jsonb)`,
      [
        itemId,
        conversationId,
        sessionId,
        actorParticipantId,
        JSON.stringify({
          notificationType: "model_error",
          retrySessionId: sessionId,
          errorMessage: "test injected error",
          excludeFromContext: true,
        }),
      ]
    )

    // Sanity: no wakeup yet.
    const pre = await pg.query(
      "SELECT id FROM session_wakeups WHERE session_id = $1",
      [sessionId]
    )
    assert.equal(pre.rows.length, 0, "no wakeup expected before retry")

    // Call retry.
    const res = await ctx.client.json<{
      retryEnqueued: boolean
      sessionId: string
      actorId: string
    }>(
      `/workspaces/${ws.id}/chat/conversations/${conversationId}/messages/${itemId}/retry`,
      { method: "POST", json: {} }
    )
    assert.equal(res.retryEnqueued, true)
    assert.equal(res.sessionId, sessionId)
    assert.equal(res.actorId, actorId)

    // Verify session_wakeups row inserted with the correct source.
    const post = await pg.query(
      `SELECT source_type, source_participant_type, source_participant_id,
              source_item_id, summary
         FROM session_wakeups
         WHERE session_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
      [sessionId]
    )
    assert.equal(post.rows.length, 1, "exactly one wakeup row after retry")
    const wakeup = post.rows[0]
    assert.equal(wakeup.source_type, "user_message")
    assert.equal(wakeup.source_participant_type, "workspace_member")
    // S19 regression guard: the source_participant_id MUST be the
    // workspace_members.id (so session-thinking.ts:922 can look it up via
    // getConversationParticipant({workspaceMemberId})). The pre-S19 bug
    // passed the assistant participant.id here, which would silently fail
    // the lookup later.
    assert.equal(
      wakeup.source_participant_id,
      workspaceMemberId,
      "source_participant_id must be workspace_members.id"
    )
    assert.equal(wakeup.source_item_id, itemId)
    assert.match(String(wakeup.summary), /retry/i)
  } finally {
    await pg.end().catch(() => undefined)
  }
})
