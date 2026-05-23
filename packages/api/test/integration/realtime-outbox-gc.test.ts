/**
 * S39: realtime_event_outbox GC.
 *
 * The S8 plan called for dropping the realtime_event_outbox table after
 * a 24h empty-table verification. That plan assumed all consumers would
 * be removed by Stage 8 (feed.item.created, the 5 dead session events,
 * etc.). One real consumer remains: chat.sync.event uses the outbox as
 * a transactional outbox so the WS fanout is guaranteed to fire iff the
 * underlying DB write commits. Dropping the table would break the chat
 * sync spine.
 *
 * Instead we add a GC pass: dispatched/failed rows older than the
 * configured retention window get deleted, so the table doesn't grow
 * forever. The test inserts synthetic rows via direct SQL, calls the
 * authenticated /_debug GC endpoint, and asserts the right rows are
 * deleted while pending rows and recent rows survive.
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
  if (!port) throw new Error("PG_PORT not set; source staging-env.sh first")
  return {
    host: process.env.SYNAPSE_STAGING_HOST || "127.0.0.1",
    port,
    user: process.env.POSTGRES_USER || "synapse",
    password: process.env.POSTGRES_PASSWORD || "",
    database: process.env.POSTGRES_DB || "synapse_staging",
  }
}

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

    // Force a GC pass via the debug endpoint with the default 24h
    // retention.
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
    const pendingId = randomUUID()
    // Even with an ancient updated_at, status='pending' means the
    // dispatcher will still try to deliver this row — must not be GC'd.
    // Set available_at far in the future so the dispatcher doesn't
    // claim it out from under us during the test.
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
