/**
 * S39/S40/S41: realtime_event_outbox GC.
 *
 * The S8 plan called for dropping the realtime_event_outbox table after
 * a 24h empty-table verification. That plan assumed all consumers would
 * be removed by Stage 8 (feed.item.created, the 5 dead session events,
 * etc.). One real consumer remains: chat.sync.event uses the outbox as
 * a transactional outbox so the WS fanout is guaranteed to fire iff the
 * underlying DB write commits. Dropping the table would break the chat
 * sync spine.
 *
 * Instead we add a GC pass: dispatched rows older than the configured
 * retention window get deleted, so the table doesn't grow forever.
 *
 * S40 hardening:
 *  - GC only deletes status='dispatched'. 'failed' is a retryable
 *    status (claimPendingRealtimeOutboxEntries treats it the same as
 *    'pending'), so deleting failed rows would silently drop events
 *    the dispatcher still intends to retry. Test asserts a 48h-old
 *    failed row survives the GC.
 *
 * S41 hardening:
 *  - The /_debug/chat/realtime-outbox-gc endpoint requires platform
 *    `super_admin` specifically — NOT the broader isPlatformAdmin set
 *    (which also admits workspace_admin and model_admin). The GC is a
 *    process-wide, cross-workspace destructive op; only super_admin
 *    is an appropriate floor. Tests cover: plain workspace owner →
 *    403, workspace_admin → 403, model_admin → 403, super_admin →
 *    200.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { Client } from "pg"
import {
  createApiClient,
  registerTestUser,
  createTestWorkspace,
} from "./setup.ts"

function pgConfig() {
  const port = Number.parseInt(process.env.PG_PORT || "0", 10)
  if (!port)
    throw new Error(
      "PG_PORT not set; export it to point at the integration test postgres"
    )
  return {
    host: process.env.SYNAPSE_STAGING_HOST || "127.0.0.1",
    port,
    user: process.env.POSTGRES_USER || "synapse",
    password: process.env.POSTGRES_PASSWORD || "",
    database: process.env.POSTGRES_DB || "synapse_staging",
  }
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
  const base = createApiClient()
  const ctx = await registerTestUser(base)
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
  const base = createApiClient()
  const ctx = await registerTestUser(base)
  const pg = new Client(pgConfig())
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
  const base = createApiClient()
  const ctx = await registerTestUser(base)
  const pg = new Client(pgConfig())
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
  const base = createApiClient()
  const ctx = await registerTestUser(base)
  const ws = await createTestWorkspace(ctx.client)
  const bootstrap = await ctx.client.json<{ workspaceMemberId: string }>(
    `/workspaces/${ws.id}/chat/bootstrap`
  )

  const pg = new Client(pgConfig())
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
  const base = createApiClient()
  const ctx = await registerTestUser(base)
  const ws = await createTestWorkspace(ctx.client)
  const bootstrap = await ctx.client.json<{ workspaceMemberId: string }>(
    `/workspaces/${ws.id}/chat/bootstrap`
  )

  const pg = new Client(pgConfig())
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
  const base = createApiClient()
  const ctx = await registerTestUser(base)
  const ws = await createTestWorkspace(ctx.client)
  const bootstrap = await ctx.client.json<{ workspaceMemberId: string }>(
    `/workspaces/${ws.id}/chat/bootstrap`
  )

  const pg = new Client(pgConfig())
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
