import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { sql } from "kysely"
import { redis } from "../infrastructure/redis/index.js"
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

/**
 * Two-worker concurrency integration test for the session lock + wakeup
 * recovery primitives that drive the session-thinking worker. Exercises the
 * REAL ioredis lock (SET NX PX + Lua CAS) and the REAL DB wakeup lifecycle —
 * the exact mechanisms that protect a session from being processed by two
 * workers at once.
 *
 * Mirrors the worker's contract:
 *   - only one worker may hold a session's lock at a time;
 *   - a worker that lost the lock (renew → false) must NOT delete the new
 *     owner's lock (fenced release);
 *   - on lock loss BEFORE side-effects, the turn's wakeups are restored to
 *     pending so the new owner re-drives them;
 *   - on lock loss AFTER side-effects, the wakeups are dropped (no replay of
 *     non-idempotent actions).
 */

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

test("lock lost BEFORE side-effects → wakeups restored to pending (new owner re-drives)", async () => {
  await withTestDb(async () => {
    const { db } = await import("../infrastructure/database/kysely.js")
    const sessionId = await seedSession(db)
    await insertPendingWakeup(db, sessionId)
    await insertPendingWakeup(db, sessionId)

    // Worker A claims the turn (attaches the pending wakeups).
    const turnId = randomUUID()
    await attachPendingWakeupsToTurn(sessionId, turnId)
    assert.equal(await getPendingWakeupCount(sessionId), 0)

    // A loses the lock before any side-effects → restore path.
    await restoreTurnWakeupsToPending(turnId)
    assert.equal(
      await getPendingWakeupCount(sessionId),
      2,
      "new owner must see the 2 wakeups as pending again"
    )
  })
})

test("lock lost AFTER side-effects → wakeups dropped (no non-idempotent replay)", async () => {
  await withTestDb(async () => {
    const { db } = await import("../infrastructure/database/kysely.js")
    const sessionId = await seedSession(db)
    await insertPendingWakeup(db, sessionId)

    const turnId = randomUUID()
    await attachPendingWakeupsToTurn(sessionId, turnId)

    // A had already started side-effects when it lost the lock → drop path.
    await markTurnWakeupsDropped(turnId)
    assert.equal(
      await getPendingWakeupCount(sessionId),
      0,
      "post-side-effect loss must NOT restore wakeups (would replay actions)"
    )
  })
})
