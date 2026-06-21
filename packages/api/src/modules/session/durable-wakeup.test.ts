import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { SUBJECT_KIND } from "@synapse/shared"
import type { Kysely } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { insertSessionWakeupRow } from "./runtime.js"

/**
 * Regression for the round-4 P0: resolved session_wakeup delivery wrote the
 * task's completion_item_id marker BEFORE the durable session_wakeups row, so a
 * crash in between left a "delivered"-looking task with no wakeup and the agent
 * hung forever. The fix routes the durable wakeup INSERT through
 * insertSessionWakeupRow on the SAME transaction as the marker (deliverTask-
 * Notice), so on commit "marker set" ⟺ "wakeup row durably present", and a
 * crash before commit rolls back both.
 *
 * These tests lock the durable primitive: it runs on a caller transaction, is
 * idempotent on (session_id, source_type, source_item_id), and rolls back
 * atomically (the marker/event would roll back with it).
 */

const NS = "durable-wakeup-test"

function rid(): string {
  return Math.random().toString(36).slice(2, 10)
}

async function buildSessionFixture(db: Kysely<any>) {
  const user = await db
    .insertInto("users")
    .values({ email: `${rid()}@${NS}`, name: "owner" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const ws = await db
    .insertInto("workspaces")
    .values({
      ownerId: user.id as string,
      slug: `ws-${rid()}`,
      name: `${NS} ws`,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const conv = await db
    .insertInto("conversations")
    .values({ kind: "group", workspaceId: ws.id as string, title: `${NS} c` })
    .returning("id")
    .executeTakeFirstOrThrow()
  const createdBySubjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.PLATFORM,
  })
  const actorRoot = await db
    .insertInto("workspaceResources")
    .values({
      id: crypto.randomUUID(),
      workspaceId: ws.id as string,
      kind: "actor",
      displayName: `${NS} actor`,
      createdBySubjectId,
      status: "active",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const actor = await db
    .insertInto("actors")
    .values({
      id: actorRoot.id as string,
      role: "assistant",
      title: `${NS} actor`,
      currentVersion: 1,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const session = await db
    .insertInto("sessions")
    .values({
      workspaceId: ws.id as string,
      actorId: actor.id as string,
      conversationId: conv.id as string,
      status: "idle",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()

  return {
    workspaceId: ws.id as string,
    conversationId: conv.id as string,
    actorId: actor.id as string,
    sessionId: session.id as string,
  }
}

// session_wakeups.source_item_id is a UUID FK → conversation_items. Mint a
// minimal item so the wakeup INSERT satisfies the FK (the wakeup's ON CONFLICT
// dedup key is this id, mirroring the real completion_item_id).
async function newConversationItem(
  db: Kysely<any>,
  fx: { conversationId: string; sessionId: string }
): Promise<string> {
  const row = await db
    .insertInto("conversationItems")
    .values({
      conversationId: fx.conversationId,
      sessionId: fx.sessionId,
      scope: "shared",
      surface: "internal",
      itemType: "event",
      subtype: "task_notice",
      role: "system",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

function wakeupParams(fx: {
  sessionId: string
  actorId: string
  workspaceId: string
}) {
  return {
    sessionId: fx.sessionId,
    actorId: fx.actorId,
    workspaceId: fx.workspaceId,
    sourceType: "system_interrupt" as const,
    sourceParticipantType: "system" as const,
    sourceName: `${NS}.tool`,
    summary: "task done",
    reasonText: "task done",
    trigger: "system_interrupt" as const,
  }
}

test(
  "insertSessionWakeupRow: persists a durable pending wakeup on the caller's transaction",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const fx = await buildSessionFixture(db)
      const sourceItemId = await newConversationItem(db, fx)

      const { created, reusedExistingWakeup } = await insertSessionWakeupRow(
        db,
        { ...wakeupParams(fx), sourceItemId }
      )

      assert.equal(reusedExistingWakeup, false, "first insert is not a reuse")
      assert.equal(created.status, "pending")
      assert.equal(created.sourceItemId, sourceItemId)

      // The row is visible within the same transaction (the durability anchor).
      const found = await db
        .selectFrom("sessionWakeups")
        .select(["id", "status"])
        .where("sessionId", "=", fx.sessionId)
        .where("sourceItemId", "=", sourceItemId)
        .executeTakeFirst()
      assert.ok(found, "wakeup row is present in the transaction")
      assert.equal(found?.status, "pending")
    })
  }
)

test(
  "insertSessionWakeupRow: idempotent on (session, source_type, source_item_id) — no duplicate on retry",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const fx = await buildSessionFixture(db)
      const sourceItemId = await newConversationItem(db, fx)

      const first = await insertSessionWakeupRow(db, {
        ...wakeupParams(fx),
        sourceItemId,
      })
      const second = await insertSessionWakeupRow(db, {
        ...wakeupParams(fx),
        sourceItemId,
      })

      assert.equal(first.reusedExistingWakeup, false)
      assert.equal(
        second.reusedExistingWakeup,
        true,
        "a retry with the same source item reuses the existing wakeup"
      )
      assert.equal(
        second.created.id,
        first.created.id,
        "the same durable row is returned (no duplicate enqueue)"
      )

      const count = await db
        .selectFrom("sessionWakeups")
        .select(({ fn }) => fn.count<number>("id").as("count"))
        .where("sessionId", "=", fx.sessionId)
        .where("sourceItemId", "=", sourceItemId)
        .executeTakeFirst()
      assert.equal(Number(count?.count), 1, "exactly one wakeup row exists")
    })
  }
)

test(
  "insertSessionWakeupRow: a rolled-back transaction leaves NO wakeup row (atomic delivery)",
  { timeout: 5 * 60_000 },
  async () => {
    // withTestDb rolls its tx back; we capture the inserted id, then a fresh
    // withTestDb (new tx) confirms nothing persisted — proving the wakeup is
    // bound to the caller's transaction, so a crash before commit loses it
    // along with the completion marker (no half-delivered state).
    let insertedId: string | undefined

    await withTestDb(async (db) => {
      const fx = await buildSessionFixture(db)
      const sourceItemId = await newConversationItem(db, fx)
      const { created } = await insertSessionWakeupRow(db, {
        ...wakeupParams(fx),
        sourceItemId,
      })
      insertedId = created.id
    })

    assert.ok(insertedId, "a row was inserted inside the (rolled-back) tx")

    await withTestDb(async (db) => {
      const found = await db
        .selectFrom("sessionWakeups")
        .select("id")
        .where("id", "=", insertedId!)
        .executeTakeFirst()
      assert.equal(
        found,
        undefined,
        "the wakeup did not persist after rollback — delivery is all-or-nothing"
      )
    })
  }
)
