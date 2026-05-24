/**
 * S39/S40/S41: realtime_event_outbox GC.
 *
 * - GC deletes dispatched rows older than retention window
 * - GC must NEVER delete 'pending' or 'failed' rows (failed is retryable)
 * - The /_debug/chat/realtime-outbox-gc endpoint requires platform
 *   super_admin specifically — NOT the broader isPlatformAdmin set
 *   (which also admits workspace_admin and model_admin).
 *
 * Must be run via tests/integration/scripts/run-test.sh.
 */

if (
  !process.env.DATABASE_URL ||
  !process.env.DATABASE_URL.includes(":55433/")
) {
  throw new Error(
    "realtime-outbox-gc.test.ts must be run via packages/api/tests/integration/scripts/run-test.sh"
  )
}

import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
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

let stack: ChatStack | undefined

before(async () => {
  stack = await setupChatStack()
})

after(async () => {
  if (stack) await teardownChatStack(stack)
})

function pgClient(): Client {
  return new Client({
    host: TEST_PG_HOST,
    port: TEST_PG_PORT,
    user: TEST_PG_USER,
    password: TEST_PG_PASSWORD,
    database: TEST_PG_DB,
  })
}

async function grantPlatformAdmin(pg: Client, userId: string) {
  await pg.query(
    `INSERT INTO platform_access_bindings
       (user_id, access_key, source, assigned_by_user_id)
     VALUES ($1, 'super_admin', 'manual', NULL)
     ON CONFLICT (user_id, access_key) DO NOTHING`,
    [userId]
  )
}

async function grantPlatformAccessKey(
  pg: Client,
  userId: string,
  accessKey: "super_admin" | "workspace_admin" | "model_admin"
) {
  await pg.query(
    `INSERT INTO platform_access_bindings
       (user_id, access_key, source, assigned_by_user_id)
     VALUES ($1, $2, 'manual', NULL)
     ON CONFLICT (user_id, access_key) DO NOTHING`,
    [userId, accessKey]
  )
}

test("debug GC endpoint rejects non-platform-admin callers with 403", async () => {
  const ctx = await registerTestUser(stack!.baseClient)
  // Plain workspace owner — no platform access keys at all.
  const res = await ctx.client.fetch(
    "/_debug/chat/realtime-outbox-gc?hours=24",
    { method: "POST", json: {} }
  )
  assert.equal(
    res.status,
    403,
    "non-platform-admin must be rejected from the global GC endpoint"
  )
  const body = (await res.json().catch(() => ({}))) as { code?: string }
  assert.equal(body.code, "platform_super_admin_required")
})

test("debug GC endpoint rejects platform workspace_admin with 403 (super_admin only)", async () => {
  // S41: isPlatformAdmin admits super_admin / workspace_admin /
  // model_admin, but only super_admin should be able to run a
  // process-wide GC. workspace_admin is scoped to workspace
  // administration — it has no business sweeping the global outbox.
  const ctx = await registerTestUser(stack!.baseClient)
  const pg = pgClient()
  await pg.connect()
  try {
    await grantPlatformAccessKey(pg, ctx.user.id, "workspace_admin")
    const res = await ctx.client.fetch(
      "/_debug/chat/realtime-outbox-gc?hours=24",
      { method: "POST", json: {} }
    )
    assert.equal(
      res.status,
      403,
      "workspace_admin must NOT be allowed to run the global outbox GC"
    )
    const body = (await res.json().catch(() => ({}))) as { code?: string }
    assert.equal(body.code, "platform_super_admin_required")
  } finally {
    await pg.end().catch(() => undefined)
  }
})

test("debug GC endpoint rejects platform model_admin with 403 (super_admin only)", async () => {
  // Same rationale as workspace_admin: model_admin is scoped to model
  // governance, not infra-level table sweeps.
  const ctx = await registerTestUser(stack!.baseClient)
  const pg = pgClient()
  await pg.connect()
  try {
    await grantPlatformAccessKey(pg, ctx.user.id, "model_admin")
    const res = await ctx.client.fetch(
      "/_debug/chat/realtime-outbox-gc?hours=24",
      { method: "POST", json: {} }
    )
    assert.equal(
      res.status,
      403,
      "model_admin must NOT be allowed to run the global outbox GC"
    )
    const body = (await res.json().catch(() => ({}))) as { code?: string }
    assert.equal(body.code, "platform_super_admin_required")
  } finally {
    await pg.end().catch(() => undefined)
  }
})

test("GC deletes dispatched rows older than retention but spares fresh dispatched rows", async () => {
  const ctx = await registerTestUser(stack!.baseClient)
  const ws = await createTestWorkspace(ctx.client)
  const bootstrap = await ctx.client.json<{ workspaceMemberId: string }>(
    `/workspaces/${ws.id}/chat/bootstrap`
  )

  const pg = pgClient()
  await pg.connect()
  try {
    await grantPlatformAdmin(pg, ctx.user.id)

    const staleId = randomUUID()
    const freshId = randomUUID()

    await pg.query(
      `INSERT INTO realtime_event_outbox
        (id, event_type, workspace_id, recipient_workspace_member_id,
         payload, event_timestamp, status, dispatched_at, created_at, updated_at)
       VALUES
        ($1, 'chat.sync.event', $2, $3, '{}'::jsonb, NOW(), 'dispatched',
         NOW() - INTERVAL '48 hours', NOW() - INTERVAL '48 hours',
         NOW() - INTERVAL '48 hours'),
        ($4, 'chat.sync.event', $2, $3, '{}'::jsonb, NOW(), 'dispatched',
         NOW(), NOW(), NOW())`,
      [staleId, ws.id, bootstrap.workspaceMemberId, freshId]
    )

    const result = await ctx.client.json<{ deleted: number }>(
      "/_debug/chat/realtime-outbox-gc?hours=24",
      { method: "POST", json: {} }
    )
    assert.ok(
      result.deleted >= 1,
      `GC must delete at least our stale fixture row (got ${result.deleted})`
    )

    const stalePost = await pg.query(
      `SELECT id FROM realtime_event_outbox WHERE id = $1`,
      [staleId]
    )
    assert.equal(
      stalePost.rows.length,
      0,
      "the >24h-old dispatched row must be deleted by the GC"
    )

    const freshPost = await pg.query(
      `SELECT id FROM realtime_event_outbox WHERE id = $1`,
      [freshId]
    )
    assert.equal(
      freshPost.rows.length,
      1,
      "the freshly-dispatched row must survive the GC pass"
    )

    await pg.query(`DELETE FROM realtime_event_outbox WHERE id = $1`, [freshId])
  } finally {
    await pg.end().catch(() => undefined)
  }
})

test("GC never deletes 'pending' rows, regardless of age", async () => {
  const ctx = await registerTestUser(stack!.baseClient)
  const ws = await createTestWorkspace(ctx.client)
  const bootstrap = await ctx.client.json<{ workspaceMemberId: string }>(
    `/workspaces/${ws.id}/chat/bootstrap`
  )

  const pg = pgClient()
  await pg.connect()
  try {
    await grantPlatformAdmin(pg, ctx.user.id)

    const pendingId = randomUUID()
    await pg.query(
      `INSERT INTO realtime_event_outbox
        (id, event_type, workspace_id, recipient_workspace_member_id,
         payload, event_timestamp, status, available_at, created_at, updated_at)
       VALUES
        ($1, 'chat.sync.event', $2, $3, '{}'::jsonb, NOW(), 'pending',
         NOW() + INTERVAL '1 hour',
         NOW() - INTERVAL '48 hours', NOW() - INTERVAL '48 hours')`,
      [pendingId, ws.id, bootstrap.workspaceMemberId]
    )

    await ctx.client.json("/_debug/chat/realtime-outbox-gc?hours=24", {
      method: "POST",
      json: {},
    })

    const survived = await pg.query(
      `SELECT id, status FROM realtime_event_outbox WHERE id = $1`,
      [pendingId]
    )
    assert.equal(
      survived.rows.length,
      1,
      "pending rows must never be GC'd, regardless of age"
    )

    await pg.query(`DELETE FROM realtime_event_outbox WHERE id = $1`, [
      pendingId,
    ])
  } finally {
    await pg.end().catch(() => undefined)
  }
})

test("GC never deletes 'failed' rows — they're retryable, not terminal", async () => {
  // The audit's S40 finding: the original GC happily deleted
  // status='failed' rows older than the retention window. But the
  // claim query at events/index.ts:99 treats 'failed' as a retryable
  // state (`WHERE status IN ('pending','failed')`), and
  // markRealtimeOutboxEntryFailed only pushes available_at out by at
  // most ~30s. So a 'failed' row with an old updated_at is either
  // currently in a retry backoff or stuck in a loop that needs ops
  // attention — it's NEVER safe to silently drop. With hours=0 (or
  // any misuse of the debug endpoint) the pre-S40 GC would have
  // dropped live realtime events.
  const ctx = await registerTestUser(stack!.baseClient)
  const ws = await createTestWorkspace(ctx.client)
  const bootstrap = await ctx.client.json<{ workspaceMemberId: string }>(
    `/workspaces/${ws.id}/chat/bootstrap`
  )

  const pg = pgClient()
  await pg.connect()
  try {
    await grantPlatformAdmin(pg, ctx.user.id)

    const failedId = randomUUID()
    await pg.query(
      `INSERT INTO realtime_event_outbox
        (id, event_type, workspace_id, recipient_workspace_member_id,
         payload, event_timestamp, status, available_at,
         attempts, last_error, created_at, updated_at)
       VALUES
        ($1, 'chat.sync.event', $2, $3, '{}'::jsonb, NOW(),
         'failed', NOW() + INTERVAL '1 hour', 3, 'stub-failure',
         NOW() - INTERVAL '48 hours', NOW() - INTERVAL '48 hours')`,
      [failedId, ws.id, bootstrap.workspaceMemberId]
    )

    // Even with hours=0 — the most aggressive setting possible —
    // 'failed' must not be GC'd.
    await ctx.client.json("/_debug/chat/realtime-outbox-gc?hours=0", {
      method: "POST",
      json: {},
    })

    const survived = await pg.query(
      `SELECT id, status FROM realtime_event_outbox WHERE id = $1`,
      [failedId]
    )
    assert.equal(
      survived.rows.length,
      1,
      "failed rows are retryable — GC must NOT delete them, even at hours=0"
    )
    assert.equal(
      survived.rows[0].status,
      "failed",
      "the row must remain in 'failed' status untouched"
    )

    await pg.query(`DELETE FROM realtime_event_outbox WHERE id = $1`, [
      failedId,
    ])
  } finally {
    await pg.end().catch(() => undefined)
  }
})
