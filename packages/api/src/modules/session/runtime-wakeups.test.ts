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
    sql`INSERT INTO users (id, email, name, password_hash) VALUES (${userId}, ${userId + "@test"}, 'tester', 'x')`.compile(
      db
    )
  )
  await db.executeQuery(
    sql`INSERT INTO workspaces (id, name, slug, owner_id) VALUES (${workspaceId}, 'ws', ${"ws-" + workspaceId.slice(0, 8)}, ${userId})`.compile(
      db
    )
  )
  await db.executeQuery(
    sql`INSERT INTO actors (id, workspace_id, name, role, title) VALUES (${actorId}, ${workspaceId}, 'A', 'assistant', 'A')`.compile(
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
  await withTestDb(async () => {
    // Use the GLOBAL db for both seeding and assertions so the SUT functions
    // (which use the global db) see the rows — same pattern as the other
    // DB-backed tests in this package.
    const { db } = await import("../../infrastructure/database/kysely.js")
    const { sessionId } = await seedSession(db)
    await insertPendingWakeup(db, sessionId)
    await insertPendingWakeup(db, sessionId)

    assert.equal(await getPendingWakeupCount(sessionId), 2)

    const turnId = randomUUID()
    const attached = await attachPendingWakeupsToTurn(sessionId, turnId)
    assert.equal(attached.length, 2)
    assert.equal(await getPendingWakeupCount(sessionId), 0) // now attached

    // Lock-loss recovery: restore instead of drop.
    await restoreTurnWakeupsToPending(turnId)
    assert.equal(
      await getPendingWakeupCount(sessionId),
      2,
      "restored wakeups must be pending again for the new owner"
    )
  })
})

test("markTurnWakeupsDropped does NOT restore (contrast with restore)", async () => {
  await withTestDb(async () => {
    const { db } = await import("../../infrastructure/database/kysely.js")
    const { sessionId } = await seedSession(db)
    await insertPendingWakeup(db, sessionId)

    const turnId = randomUUID()
    await attachPendingWakeupsToTurn(sessionId, turnId)
    await markTurnWakeupsDropped(turnId)
    assert.equal(
      await getPendingWakeupCount(sessionId),
      0,
      "dropped wakeups stay dropped"
    )
  })
})
