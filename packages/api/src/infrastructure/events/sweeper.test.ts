/**
 * WI-3: the realtime outbox dispatcher recovers rows stranded in 'processing'
 * by a crashed dispatcher (which otherwise are never re-claimed and the event
 * is silently never delivered).
 *
 * recoverStuckProcessingRealtimeOutboxEntries operates on the GLOBAL db
 * (events/index.ts binds db to DATABASE_URL), so this seeds + asserts via that
 * same global handle and is skipped when DATABASE_URL is unset.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { sql } from "kysely"

const HAS_DB = Boolean(process.env.DATABASE_URL)
const maybe = HAS_DB ? test : test.skip

function rid() {
  return Math.random().toString(36).slice(2, 10)
}

maybe(
  "stuck 'processing' rows older than the timeout are reset to 'failed'; fresh ones are left alone",
  { timeout: 5 * 60_000 },
  async () => {
    const { db } = await import("../database/kysely.js")
    const { recoverStuckProcessingRealtimeOutboxEntries } =
      await import("./index.js")

    const user = (
      await db
        .insertInto("users")
        .values({ email: `sw-${rid()}@e.test`, name: "sweeper" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id as string
    const workspaceId = (
      await db
        .insertInto("workspaces")
        .values({ owner_id: user, slug: `ws-${rid()}`, name: "sweeper ws" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id as string
    const workspaceMemberId = (
      await db
        .insertInto("workspace_members")
        .values({
          workspace_id: workspaceId,
          user_id: user,
          trust_level: "member",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id as string

    const stuck = (
      await db
        .insertInto("realtime_event_outbox")
        .values({
          event_type: "chat.sync.event",
          workspace_id: workspaceId,
          recipient_workspace_member_id: workspaceMemberId,
          payload: sql`'{}'::jsonb`,
          event_timestamp: sql`NOW()`,
          status: "processing",
          processing_started_at: sql`NOW() - INTERVAL '10 minutes'`,
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id as string

    const fresh = (
      await db
        .insertInto("realtime_event_outbox")
        .values({
          event_type: "chat.sync.event",
          workspace_id: workspaceId,
          recipient_workspace_member_id: workspaceMemberId,
          payload: sql`'{}'::jsonb`,
          event_timestamp: sql`NOW()`,
          status: "processing",
          processing_started_at: sql`NOW()`,
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id as string

    const recovered = await recoverStuckProcessingRealtimeOutboxEntries(30_000)
    assert.ok(recovered >= 1, "the stuck row was recovered")

    const stuckRow = await db
      .selectFrom("realtime_event_outbox")
      .select(["status"])
      .where("id", "=", stuck)
      .executeTakeFirstOrThrow()
    assert.equal(stuckRow.status, "failed", "stuck row reset to failed")

    const freshRow = await db
      .selectFrom("realtime_event_outbox")
      .select(["status"])
      .where("id", "=", fresh)
      .executeTakeFirstOrThrow()
    assert.equal(freshRow.status, "processing", "fresh row left alone")
  }
)
