// Integration test: runtime snapshot inheritance + the requeue-from-blocked
// cache-clearing contract.
//
// Regression for the bug fixed in 06770de (phase) and the follow-up that
// added the same clearing for statusText / lastError. buildSessionRuntimeSnapshot
// inherits cached snapshot fields when overrides don't supply them; for
// laneState ∈ {running, queued, blocked}, phase / statusText / lastError can
// leak through from a previous "blocked" cache into a fresh "queued" snapshot
// when the requeue path forgets to override them. The IM hook and the chat
// runtime UI both read those fields, so a leaked stale failure visibly lies
// about the session state ("Queued follow-up messages" or worse, the literal
// old error string).
//
// What this test locks:
//   1. With NO clearing overrides, requeue-from-blocked inherits the stale
//      blocked-snapshot fields (this is the bug shape — kept as a regression
//      so future refactors don't silently start clearing them and then break
//      callers that legitimately want the inherit behavior).
//   2. With the actual fix overrides ({phase:"idle", statusText:null,
//      lastError:null}), the new snapshot is clean — no statusText, no
//      lastError, phase="idle", health="ok", laneState="queued". This is the
//      shape enqueueSessionWakeup now emits when transitioning out of blocked.
//
// Run via: bash packages/api/tests/integration/scripts/run-test.sh \
//   packages/api/tests/integration/session-runtime-snapshot.test.ts

if (process.env.SYNAPSE_INT_TEST !== "1") {
  throw new Error(
    "session-runtime-snapshot.test.ts must be run via packages/api/tests/integration/scripts/run-test.sh"
  )
}

import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { v4 as uuidv4 } from "uuid"
import pg from "pg"

import { publishSessionRuntime } from "../../src/modules/session/runtime.js"
import { updateSessionStatus } from "../../src/modules/session/service.js"

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
  seed = await seedMinimal({ workspaceSlugSuffix: "rt-snap" })
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

async function buildSessionFixture(): Promise<{
  workspaceId: string
  sessionId: string
  actorId: string
  conversationId: string
}> {
  if (!seed || !client) throw new Error("fixtures missing")
  const conversationId = uuidv4()
  const sessionId = uuidv4()

  const actorId = uuidv4()
  await client.query("BEGIN")
  try {
    await client.query(
      `INSERT INTO workspace_apps (id, workspace_id, kind, display_name, owner_workspace_member_id, status)
       VALUES ($1, $2, 'actor', 'Snapshot Test Actor', $3, 'active')`,
      [actorId, seed.workspaceId, seed.workspaceMemberId]
    )
    await client.query(
      `INSERT INTO actors (id, role, title)
       VALUES ($1, 'assistant', 'tester')`,
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

  return {
    workspaceId: seed.workspaceId,
    sessionId,
    actorId,
    conversationId,
  }
}

async function stageBlockedCache(opts: {
  workspaceId: string
  sessionId: string
  errorMessage: string
}) {
  // Flip session to blocked first so the snapshot builder accepts the
  // blocked laneState override and the row.status reflects it.
  await updateSessionStatus(opts.sessionId, "blocked", {
    errorMessage: opts.errorMessage,
  })
  const snapshot = await publishSessionRuntime(
    opts.workspaceId,
    opts.sessionId,
    {
      laneState: "blocked",
      health: "error",
      phase: "error",
      statusText: opts.errorMessage,
      lastError: { message: opts.errorMessage, at: new Date().toISOString() },
    }
  )
  assert.ok(snapshot, "blocked publish should produce a snapshot")
  assert.equal(snapshot!.laneState, "blocked")
  assert.equal(snapshot!.health, "error")
  assert.equal(snapshot!.phase, "error")
  assert.equal(snapshot!.statusText, opts.errorMessage)
  assert.equal(snapshot!.lastError?.message, opts.errorMessage)
  return snapshot!
}

test("requeue WITHOUT clearing overrides inherits stale statusText / lastError / phase from blocked cache (bug shape)", async () => {
  const fixture = await buildSessionFixture()
  await stageBlockedCache({
    workspaceId: fixture.workspaceId,
    sessionId: fixture.sessionId,
    errorMessage: "boom — provider 503",
  })

  // Flip back to queued and clear DB error_message — same as the real
  // enqueueSessionWakeup() does — but DO NOT pass any clearing overrides
  // to publishSessionRuntime. This is the pre-fix shape; the snapshot
  // should leak stale fields through buildSessionRuntimeSnapshot's
  // inherit-from-cache fallback.
  await updateSessionStatus(fixture.sessionId, "queued", { errorMessage: null })
  const leaky = await publishSessionRuntime(
    fixture.workspaceId,
    fixture.sessionId,
    {
      laneState: "queued",
      health: "ok",
    }
  )
  assert.ok(leaky, "queued publish should produce a snapshot")
  assert.equal(leaky!.laneState, "queued")
  assert.equal(leaky!.health, "ok")
  // The leak: cached fields survive.
  assert.equal(
    leaky!.phase,
    "error",
    "without phase override, cached 'error' phase leaks into queued snapshot"
  )
  assert.equal(
    leaky!.statusText,
    "boom — provider 503",
    "without statusText override, cached error message leaks into queued snapshot"
  )
  assert.equal(
    leaky!.lastError?.message,
    "boom — provider 503",
    "without lastError override, cached lastError leaks into queued snapshot"
  )
})

test("requeue WITH clearing overrides ({phase:'idle', statusText:null, lastError:null}) produces a clean snapshot", async () => {
  const fixture = await buildSessionFixture()
  await stageBlockedCache({
    workspaceId: fixture.workspaceId,
    sessionId: fixture.sessionId,
    errorMessage: "boom — second case",
  })

  await updateSessionStatus(fixture.sessionId, "queued", { errorMessage: null })
  // The shape enqueueSessionWakeup now emits on requeue-from-blocked.
  const clean = await publishSessionRuntime(
    fixture.workspaceId,
    fixture.sessionId,
    {
      laneState: "queued",
      health: "ok",
      phase: "idle",
      statusText: null,
      lastError: null,
    }
  )
  assert.ok(clean, "queued publish should produce a snapshot")
  assert.equal(clean!.laneState, "queued")
  assert.equal(clean!.health, "ok")
  assert.equal(
    clean!.phase,
    "idle",
    "phase override should win over cached 'error'"
  )
  assert.equal(
    clean!.statusText,
    undefined,
    "statusText: null override should clear the inherited error message"
  )
  assert.equal(
    clean!.lastError,
    undefined,
    "lastError: null override should clear the inherited lastError"
  )
})

test("statusText: null clearing is honored even when other fields are inherited", async () => {
  // Isolation test for the override path: cache has statusText, the second
  // publish only sends statusText: null without touching other overrides.
  // statusText must clear; other fields fall back to their normal defaults
  // (not asserted on here — the previous test covers them).
  const fixture = await buildSessionFixture()
  await publishSessionRuntime(fixture.workspaceId, fixture.sessionId, {
    laneState: "running",
    health: "ok",
    phase: "thinking",
    statusText: "Analyzing message...",
  })

  const after = await publishSessionRuntime(
    fixture.workspaceId,
    fixture.sessionId,
    {
      laneState: "running",
      statusText: null,
    }
  )
  assert.ok(after)
  assert.equal(
    after!.statusText,
    undefined,
    "statusText: null clears cached 'Analyzing message...'"
  )
})

test("lastError: null clearing is honored even when health stays 'ok'", async () => {
  // Sanity that the lastError clearing is independent of health.
  const fixture = await buildSessionFixture()
  await publishSessionRuntime(fixture.workspaceId, fixture.sessionId, {
    laneState: "blocked",
    health: "error",
    phase: "error",
    lastError: { message: "first failure", at: new Date().toISOString() },
  })
  await updateSessionStatus(fixture.sessionId, "queued", { errorMessage: null })

  const after = await publishSessionRuntime(
    fixture.workspaceId,
    fixture.sessionId,
    {
      laneState: "queued",
      health: "ok",
      lastError: null,
    }
  )
  assert.ok(after)
  assert.equal(after!.lastError, undefined)
})

test("worker-startup publish WITHOUT lastError:null leaks stale cached lastError (regression anchor for the bypass-path bug)", async () => {
  // Simulates the bypass shape: something requeued a previously-blocked
  // session WITHOUT going through enqueueSessionWakeup()'s clearing
  // overrides (the historical relay-manager CUA termination did this via
  // raw SQL + direct sessionThinkingQueue.add). Result: cache still
  // carries lastError. The worker then starts and publishes
  // {laneState:"running", health:"ok", phase:"thinking", statusText:"Analyzing message..."}
  // — exactly the original session-thinking emit shape, with no
  // lastError override. snapshot builder inherits from cache.
  const fixture = await buildSessionFixture()
  await stageBlockedCache({
    workspaceId: fixture.workspaceId,
    sessionId: fixture.sessionId,
    errorMessage: "old provider 500",
  })
  await updateSessionStatus(fixture.sessionId, "running", {
    errorMessage: null,
  })

  const leaky = await publishSessionRuntime(
    fixture.workspaceId,
    fixture.sessionId,
    {
      laneState: "running",
      health: "ok",
      phase: "thinking",
      statusText: "Analyzing message...",
    }
  )
  assert.ok(leaky)
  // The leak: cached lastError survives because the worker's first
  // emit didn't override it. Dashboard runtime-ui.ts:90 would print
  // "old provider 500" even though the session is healthily running.
  assert.equal(leaky!.lastError?.message, "old provider 500")
  // statusText is fine here because the worker explicitly overrides it.
  assert.equal(leaky!.statusText, "Analyzing message...")
})

test("worker-startup publish WITH lastError:null produces a clean snapshot from blocked cache (defense in depth)", async () => {
  // This is the post-fix shape session-thinking.ts:emitThinkingStatus now
  // emits. Even if some future bypass leaves stale fields in the cache,
  // the worker's first publish self-heals lastError on the way to
  // "running".
  const fixture = await buildSessionFixture()
  await stageBlockedCache({
    workspaceId: fixture.workspaceId,
    sessionId: fixture.sessionId,
    errorMessage: "old provider 500 (defense case)",
  })
  await updateSessionStatus(fixture.sessionId, "running", {
    errorMessage: null,
  })

  const clean = await publishSessionRuntime(
    fixture.workspaceId,
    fixture.sessionId,
    {
      laneState: "running",
      health: "ok",
      phase: "thinking",
      statusText: "Analyzing message...",
      lastError: null,
    }
  )
  assert.ok(clean)
  assert.equal(clean!.lastError, undefined)
  assert.equal(clean!.statusText, "Analyzing message...")
  assert.equal(clean!.health, "ok")
  assert.equal(clean!.phase, "thinking")
})

test("putSessionToIdle terminal publish WITH lastError/statusText:null fully clears even if cache had stale failure (defense in depth)", async () => {
  // Mirrors the new putSessionToIdle shape: terminal idle transition
  // explicitly clears any cached failure so the final snapshot stays
  // honest.
  const fixture = await buildSessionFixture()
  await stageBlockedCache({
    workspaceId: fixture.workspaceId,
    sessionId: fixture.sessionId,
    errorMessage: "tool timeout",
  })
  await updateSessionStatus(fixture.sessionId, "idle", { errorMessage: null })

  const clean = await publishSessionRuntime(
    fixture.workspaceId,
    fixture.sessionId,
    {
      laneState: "idle",
      phase: "idle",
      statusText: null,
      lastError: null,
    }
  )
  assert.ok(clean)
  assert.equal(clean!.laneState, "idle")
  assert.equal(clean!.phase, "idle")
  assert.equal(clean!.statusText, undefined)
  assert.equal(clean!.lastError, undefined)
})

test("worker early-return-no-pending-wakeups publish clears cached blocked-failure fields (regression for session-thinking.ts:227)", async () => {
  // session-thinking.ts has a pre-turn early-return: if the worker boots
  // and finds pendingWakeupsAtStart === 0 and session.status !== "running"
  // (e.g. a peer worker already drained the wakeup, or a stale job is
  // being retried), it flips the DB to idle and publishes a clean
  // runtime snapshot. Before this fix that publish was
  //   { laneState:"idle", health:"ok", phase:"idle" }
  // with no lastError/statusText override, so a previous blocked
  // snapshot's failure fields would leak through into the "idle/ok"
  // shape — DB says clean but the dashboard kept showing the old
  // error.
  const fixture = await buildSessionFixture()
  await stageBlockedCache({
    workspaceId: fixture.workspaceId,
    sessionId: fixture.sessionId,
    errorMessage: "previous worker crashed",
  })
  await updateSessionStatus(fixture.sessionId, "idle", { errorMessage: null })

  // The exact shape worker now emits on the early-return path.
  const clean = await publishSessionRuntime(
    fixture.workspaceId,
    fixture.sessionId,
    {
      laneState: "idle",
      health: "ok",
      phase: "idle",
      statusText: null,
      lastError: null,
    }
  )
  assert.ok(clean)
  assert.equal(clean!.laneState, "idle")
  assert.equal(clean!.health, "ok")
  assert.equal(clean!.phase, "idle")
  assert.equal(
    clean!.statusText,
    undefined,
    "early-return idle snapshot must not carry the previous failure's statusText"
  )
  assert.equal(
    clean!.lastError,
    undefined,
    "early-return idle snapshot must not carry the previous failure's lastError"
  )
})
