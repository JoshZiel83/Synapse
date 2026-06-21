import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { sql } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import {
  attachPendingWakeupsToTurn,
  markTurnWakeupsDropped,
  restoreTurnWakeupsToPending,
  getPendingWakeupCount,
} from "./runtime.js"

/**
 * Seed the minimal FK chain a session_wakeups row needs:
 * user → workspace → actor + conversation → session.
 */
async function seedSession(db: any): Promise<{ sessionId: string }> {
  const userId = randomUUID()
  const workspaceId = randomUUID()
  const actorId = randomUUID()
  const conversationId = randomUUID()
  const sessionId = randomUUID()

  await db.executeQuery(
    sql`INSERT INTO users (id, email, name) VALUES (${userId}, ${`${userId}@test`}, 'tester')`.compile(
      db
    )
  )
  await db.executeQuery(
    sql`INSERT INTO workspaces (id, name, slug, owner_id) VALUES (${workspaceId}, 'ws', ${`ws-${workspaceId.slice(0, 8)}`}, ${userId})`.compile(
      db
    )
  )
  // workspace_resources.created_by_subject_id is NOT NULL with no default; mint a
  // workspace-kind access_subject (same workspace) to satisfy it. The fixture has
  // no owning member, so owner_subject_id stays NULL (a system/actor-created
  // resource).
  const creatorSubjectId = randomUUID()
  await db.executeQuery(
    sql`INSERT INTO access_subjects (id, kind, workspace_id) VALUES (${creatorSubjectId}, 'workspace', ${workspaceId})`.compile(
      db
    )
  )
  await db.executeQuery(
    sql`INSERT INTO workspace_resources (id, workspace_id, kind, display_name, status, created_by_subject_id)
        VALUES (${actorId}, ${workspaceId}, 'actor', 'A', 'active', ${creatorSubjectId})`.compile(
      db
    )
  )
  await db.executeQuery(
    sql`INSERT INTO actors (id, role, title) VALUES (${actorId}, 'assistant', 'A')`.compile(
      db
    )
  )
  await db.executeQuery(
    sql`INSERT INTO conversations (id, workspace_id, kind) VALUES (${conversationId}, ${workspaceId}, 'direct')`.compile(
      db
    )
  )
  await db.executeQuery(
    sql`INSERT INTO sessions (id, workspace_id, actor_id, conversation_id) VALUES (${sessionId}, ${workspaceId}, ${actorId}, ${conversationId})`.compile(
      db
    )
  )
  return { sessionId }
}

async function insertPendingWakeup(db: any, sessionId: string) {
  await db.executeQuery(
    sql`INSERT INTO session_wakeups (id, session_id, source_type, summary, status)
        VALUES (${randomUUID()}, ${sessionId}, 'user_message', 'hello', 'pending')`.compile(
      db
    )
  )
}

test("restoreTurnWakeupsToPending: attached → pending so a new owner can re-claim", async () => {
  await withTestDb(async (db) => {
    const { sessionId } = await seedSession(db)
    await insertPendingWakeup(db, sessionId)
    await insertPendingWakeup(db, sessionId)

    assert.equal(await getPendingWakeupCount(sessionId, db), 2)

    const turnId = randomUUID()
    const attached = await attachPendingWakeupsToTurn(sessionId, turnId, db)
    assert.equal(attached.length, 2)
    assert.equal(await getPendingWakeupCount(sessionId, db), 0) // now attached

    // Lock-loss recovery: restore instead of drop.
    await restoreTurnWakeupsToPending(turnId, db)
    assert.equal(
      await getPendingWakeupCount(sessionId, db),
      2,
      "restored wakeups must be pending again for the new owner"
    )
  })
})

test("markTurnWakeupsDropped does NOT restore (contrast with restore)", async () => {
  await withTestDb(async (db) => {
    const { sessionId } = await seedSession(db)
    await insertPendingWakeup(db, sessionId)

    const turnId = randomUUID()
    await attachPendingWakeupsToTurn(sessionId, turnId, db)
    await markTurnWakeupsDropped(turnId, db)
    assert.equal(
      await getPendingWakeupCount(sessionId, db),
      0,
      "dropped wakeups stay dropped"
    )
  })
})
