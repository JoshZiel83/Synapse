import test, { after } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { sql } from "kysely"
import {
  redis,
  shutdownRedisConnections,
} from "../infrastructure/redis/index.js"
import {
  acquireLock,
  renewLock,
  releaseLock,
} from "../infrastructure/redis/lock.js"
import { withTestDb } from "../test/helpers/db.js"
import {
  attachPendingWakeupsToTurn,
  markTurnWakeupsDropped,
  restoreTurnWakeupsToPending,
  getPendingWakeupCount,
} from "../modules/session/runtime.js"
import { decideLockLossRecovery } from "./session-thinking.js"

/**
 * Two-worker concurrency integration test for the session lock + wakeup
 * recovery primitives that drive the session-thinking worker. Exercises the
 * REAL ioredis lock (SET NX PX + Lua CAS) and the REAL DB wakeup lifecycle —
 * the exact mechanisms that protect a session from being processed by two
 * workers at once — PLUS the worker's lock-loss recovery POLICY
 * (decideLockLossRecovery), so the replay-safe/unsafe + requeue decisions are
 * directly covered (not just the underlying restore/drop primitives).
 *
 * Mirrors the worker's contract:
 *   - only one worker may hold a session's lock at a time;
 *   - a worker that lost the lock (renew → false) must NOT delete the new
 *     owner's lock (fenced release);
 *   - replay-SAFE lock loss restores wakeups → pending; replay-UNSAFE drops
 *     them; either way it requeues iff wakeups remain pending.
 */

// This suite materializes the shared ioredis singleton; close it so the test
// process exits instead of hanging on the open connection.
after(async () => {
  await shutdownRedisConnections().catch(() => {})
})

const lockKey = (sessionId: string) => `synapse:session:lock:${sessionId}`
const TTL = 30_000

test("two workers race the same session lock: exactly one wins", async () => {
  const sessionId = randomUUID()
  const key = lockKey(sessionId)
  try {
    // Both workers attempt acquisition concurrently.
    const [a, b] = await Promise.all([
      acquireLock(redis, key, TTL),
      acquireLock(redis, key, TTL),
    ])
    const winners = [a, b].filter(Boolean)
    assert.equal(winners.length, 1, "exactly one worker must acquire the lock")
    // A third, later attempt also loses while the winner holds it.
    const c = await acquireLock(redis, key, TTL)
    assert.equal(c, null, "lock is held — a later worker is rejected")
    // Winner releases; now it can be acquired again.
    await releaseLock(redis, winners[0]!)
    const d = await acquireLock(redis, key, TTL)
    assert.ok(d, "after release the lock is acquirable again")
    await releaseLock(redis, d!)
  } finally {
    await redis.del(key).catch(() => {})
  }
})

test("takeover: stale worker's renew fails and its release does NOT kill the new owner's lock", async () => {
  const sessionId = randomUUID()
  const key = lockKey(sessionId)
  try {
    const workerA = await acquireLock(redis, key, TTL)
    assert.ok(workerA)

    // Simulate A's lease lapsing (TTL expiry) and worker B taking over.
    await redis.del(key)
    const workerB = await acquireLock(redis, key, TTL)
    assert.ok(workerB)
    assert.notEqual(workerA!.token, workerB!.token)

    // A keeps running and tries to renew — must observe it LOST the lock.
    // (This false return is exactly what sets lockLost in the worker.)
    assert.equal(
      await renewLock(redis, workerA!, TTL),
      false,
      "stale worker's renew must fail after takeover"
    )

    // A then reaches its finally and releases — fenced, so it must NOT delete
    // B's lock.
    await releaseLock(redis, workerA!)
    const stillHeld = await redis.get(key)
    assert.equal(
      stillHeld,
      workerB!.token,
      "B still holds the lock after A's release"
    )

    // B renews fine and releases cleanly.
    assert.equal(await renewLock(redis, workerB!, TTL), true)
    await releaseLock(redis, workerB!)
    assert.equal(await redis.get(key), null)
  } finally {
    await redis.del(key).catch(() => {})
  }
})

// ── DB-backed wakeup recovery under takeover ───────────────────────────────

async function seedSession(db: any): Promise<string> {
  const userId = randomUUID()
  const workspaceId = randomUUID()
  const actorId = randomUUID()
  const conversationId = randomUUID()
  const sessionId = randomUUID()
  await db.executeQuery(
    sql`INSERT INTO users (id, email, name) VALUES (${userId}, ${userId + "@test"}, 'tester')`.compile(
      db
    )
  )
  await db.executeQuery(
    sql`INSERT INTO workspaces (id, name, slug, owner_id) VALUES (${workspaceId}, 'ws', ${"ws-" + workspaceId.slice(0, 8)}, ${userId})`.compile(
      db
    )
  )
  await db.executeQuery(
    sql`INSERT INTO workspace_apps (id, workspace_id, kind, display_name, status)
        VALUES (${actorId}, ${workspaceId}, 'actor', 'A', 'active')`.compile(db)
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
  return sessionId
}

async function insertPendingWakeup(db: any, sessionId: string) {
  await db.executeQuery(
    sql`INSERT INTO session_wakeups (id, session_id, source_type, summary, status)
        VALUES (${randomUUID()}, ${sessionId}, 'user_message', 'hi', 'pending')`.compile(
      db
    )
  )
}

/**
 * Apply the worker's lock-loss recovery policy end-to-end against the real DB:
 * pick restore/drop via decideLockLossRecovery, apply it, then re-read pending
 * and compute the requeue decision the same way the handler does.
 */
async function runLockLossRecovery(
  db: any,
  sessionId: string,
  turnId: string,
  replayUnsafeStarted: boolean
): Promise<{ wakeupAction: string; requeue: boolean }> {
  const action = decideLockLossRecovery({
    replayUnsafeStarted,
    pendingAfterRecovery: 0, // provisional; recomputed after applying
  }).wakeupAction
  if (action === "drop") {
    await markTurnWakeupsDropped(turnId, db)
  } else {
    await restoreTurnWakeupsToPending(turnId, db)
  }
  const pendingAfterRecovery = await getPendingWakeupCount(sessionId, db)
  const recovery = decideLockLossRecovery({
    replayUnsafeStarted,
    pendingAfterRecovery,
  })
  return { wakeupAction: action, requeue: recovery.requeue }
}

test("lock lost while REPLAY-SAFE → restore wakeups + requeue (new owner re-drives)", async () => {
  await withTestDb(async (db) => {
    const sessionId = await seedSession(db)
    await insertPendingWakeup(db, sessionId)
    await insertPendingWakeup(db, sessionId)

    const turnId = randomUUID()
    await attachPendingWakeupsToTurn(sessionId, turnId, db)
    assert.equal(await getPendingWakeupCount(sessionId, db), 0)

    const r = await runLockLossRecovery(db, sessionId, turnId, false)
    assert.equal(r.wakeupAction, "restore")
    assert.equal(
      await getPendingWakeupCount(sessionId, db),
      2,
      "restored wakeups must be pending again"
    )
    assert.equal(r.requeue, true, "must requeue so the new owner drives them")
  })
})

test("pure-reasoning turn (no actions/message) is REPLAY-SAFE → wakeups restored not dropped", async () => {
  // Regression for the bug where sideEffectsStarted flipped true even with zero
  // actions, dropping a reasoning-only turn's input wakeups.
  await withTestDb(async (db) => {
    const sessionId = await seedSession(db)
    await insertPendingWakeup(db, sessionId)

    const turnId = randomUUID()
    await attachPendingWakeupsToTurn(sessionId, turnId, db)

    // replayUnsafeStarted stays false for a no-action, no-message turn.
    const r = await runLockLossRecovery(db, sessionId, turnId, false)
    assert.equal(r.wakeupAction, "restore")
    assert.equal(
      await getPendingWakeupCount(sessionId, db),
      1,
      "reasoning-only turn must NOT lose its input wakeup"
    )
    assert.equal(r.requeue, true)
  })
})

test("lock lost while REPLAY-UNSAFE → drop this turn's wakeups (no replay)", async () => {
  await withTestDb(async (db) => {
    const sessionId = await seedSession(db)
    await insertPendingWakeup(db, sessionId)

    const turnId = randomUUID()
    await attachPendingWakeupsToTurn(sessionId, turnId, db)

    const r = await runLockLossRecovery(db, sessionId, turnId, true)
    assert.equal(r.wakeupAction, "drop")
    assert.equal(
      await getPendingWakeupCount(sessionId, db),
      0,
      "replay-unsafe loss must NOT restore this turn's wakeups"
    )
    assert.equal(r.requeue, false, "nothing else pending → no requeue")
  })
})

test("REPLAY-UNSAFE loss still requeues for LATE independent pending wakeups", async () => {
  // Regression for the bug where post-side-effect loss skipped the pending
  // check, stranding a message that arrived mid-turn (never attached to it).
  await withTestDb(async (db) => {
    const sessionId = await seedSession(db)
    await insertPendingWakeup(db, sessionId) // this turn's input

    const turnId = randomUUID()
    await attachPendingWakeupsToTurn(sessionId, turnId, db)

    // A LATE wakeup arrives mid-turn (not attached to this turn).
    await insertPendingWakeup(db, sessionId)

    const r = await runLockLossRecovery(db, sessionId, turnId, true)
    assert.equal(r.wakeupAction, "drop") // this turn's own wakeup dropped
    assert.equal(
      await getPendingWakeupCount(sessionId, db),
      1,
      "the late independent wakeup is still pending"
    )
    assert.equal(
      r.requeue,
      true,
      "must requeue to drive the late wakeup — without replaying this turn"
    )
  })
})
