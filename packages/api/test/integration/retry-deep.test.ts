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
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { Client } from "pg"
import {
  createApiClient,
  registerTestUser,
  createTestWorkspace,
} from "./setup.ts"

const uuid = () =>
  ([8, 4, 4, 4, 12] as const)
    .map((len) => randomBytes(len / 2).toString("hex"))
    .join("-")

function pgConfig() {
  // Connect to the staging postgres on its host-bound port from this
  // worktree's .env.staging.local (already exported by staging-env.sh).
  const port = Number.parseInt(process.env.PG_PORT || "0", 10)
  if (!port) throw new Error("PG_PORT not set; source staging-env.sh first")
  return {
    host: process.env.SYNAPSE_STAGING_HOST || "127.0.0.1",
    port,
    user: process.env.POSTGRES_USER || "synapse",
    password: process.env.POSTGRES_PASSWORD || "",
    database: process.env.POSTGRES_DB || "synapse_staging",
  }
}

test("retry succeeds end-to-end and enqueues a session_wakeup with the correct workspace_member source", async () => {
  const base = createApiClient()
  const ctx = await registerTestUser(base)
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
      boundary: "internal",
      title: "retry-deep-test",
      workspaceMemberIds: [],
    },
  })
  const conversationId = created.conversation.conversationId

  const pg = new Client(pgConfig())
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
    await pg.query(
      `INSERT INTO conversation_participants
        (id, conversation_id, participant_type, actor_id, role_key, state)
       VALUES ($1, $2, 'actor', $3, 'member', 'active')`,
      [actorParticipantId, conversationId, actorId]
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
