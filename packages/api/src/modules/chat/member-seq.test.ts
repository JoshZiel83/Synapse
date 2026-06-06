import test from "node:test"
import assert from "node:assert/strict"
import { getSharedTestDb } from "../../test/helpers/db.js"
import { appendWorkspaceMemberSyncEventInTransaction } from "./service.js"

type AnyDb = import("kysely").Kysely<any>

async function seedMember(db: AnyDb): Promise<{
  workspaceId: string
  workspaceMemberId: string
}> {
  const user = await db
    .insertInto("users")
    .values({
      email: `mseq-${Math.random().toString(36).slice(2, 10)}@example.test`,
      name: "member-seq test user",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const workspace = await db
    .insertInto("workspaces")
    .values({
      owner_id: user.id as string,
      slug: `ws-${Math.random().toString(36).slice(2, 10)}`,
      name: "member-seq workspace",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const member = await db
    .insertInto("workspace_members")
    .values({
      workspace_id: workspace.id as string,
      user_id: user.id as string,
      trust_level: "member",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return {
    workspaceId: workspace.id as string,
    workspaceMemberId: member.id as string,
  }
}

// The core of the WI-2 fix: member_seq must be per-member, commit-ordered, and
// gap-free even under concurrency. These run against the SHARED test container
// (a real Pool) so the advisory-lock serialization is exercised for real.

test(
  "appendWorkspaceMemberSyncEventInTransaction assigns contiguous member_seq sequentially",
  { timeout: 5 * 60_000 },
  async () => {
    const { db } = await getSharedTestDb()
    // Seed on the real container db (rows must persist across the concurrent
    // transactions below — not rolled back like withTestDb).
    const seeded = await seedMember(db as unknown as AnyDb)
    const workspaceId = seeded.workspaceId
    const workspaceMemberId = seeded.workspaceMemberId

    const N = 12
    for (let i = 0; i < N; i++) {
      await db.transaction().execute((trx) =>
        appendWorkspaceMemberSyncEventInTransaction(trx, {
          workspaceId,
          workspaceMemberId,
          eventType: "conversation.upsert",
          payload: { conversation: { conversationId: `c-${i}` } as never },
        })
      )
    }

    const rows = await db
      .selectFrom("workspace_member_sync_events")
      .select(["member_seq"])
      .where("workspace_member_id", "=", workspaceMemberId)
      .orderBy("member_seq", "asc")
      .execute()

    const seqs = rows.map((r) => Number(r.member_seq))
    assert.deepEqual(
      seqs,
      Array.from({ length: N }, (_, i) => i + 1),
      "member_seq should be 1..N contiguous"
    )
  }
)

test(
  "concurrent appends for the same member produce a gap-free 1..N member_seq",
  { timeout: 5 * 60_000 },
  async () => {
    const { db } = await getSharedTestDb()
    const seeded = await seedMember(db as unknown as AnyDb)

    const N = 24
    // Fire all appends concurrently. The advisory xact lock must serialize them
    // so the resulting member_seq set is exactly {1..N} with no holes and no
    // duplicates — the property the client cursor relies on.
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        db.transaction().execute((trx) =>
          appendWorkspaceMemberSyncEventInTransaction(trx, {
            workspaceId: seeded.workspaceId,
            workspaceMemberId: seeded.workspaceMemberId,
            eventType: "conversation.upsert",
            payload: { conversation: { conversationId: `cc-${i}` } as never },
          })
        )
      )
    )

    const rows = await db
      .selectFrom("workspace_member_sync_events")
      .select(["member_seq"])
      .where("workspace_member_id", "=", seeded.workspaceMemberId)
      .orderBy("member_seq", "asc")
      .execute()

    const seqs = rows.map((r) => Number(r.member_seq))
    assert.equal(seqs.length, N, "should have N rows")
    assert.deepEqual(
      seqs,
      Array.from({ length: N }, (_, i) => i + 1),
      "concurrent member_seq must be gap-free 1..N"
    )
    assert.equal(new Set(seqs).size, N, "no duplicate member_seq")
  }
)

test(
  "member_seq is independent per workspace member",
  { timeout: 5 * 60_000 },
  async () => {
    const { db } = await getSharedTestDb()
    const a = await seedMember(db as unknown as AnyDb)
    const b = await seedMember(db as unknown as AnyDb)

    // Interleave appends across two members; each should get its own 1..3.
    const append = (m: typeof a, i: number) =>
      db.transaction().execute((trx) =>
        appendWorkspaceMemberSyncEventInTransaction(trx, {
          workspaceId: m.workspaceId,
          workspaceMemberId: m.workspaceMemberId,
          eventType: "conversation.upsert",
          payload: { conversation: { conversationId: `x-${i}` } as never },
        })
      )
    await append(a, 0)
    await append(b, 0)
    await append(a, 1)
    await append(b, 1)
    await append(a, 2)
    await append(b, 2)

    for (const m of [a, b]) {
      const rows = await db
        .selectFrom("workspace_member_sync_events")
        .select(["member_seq"])
        .where("workspace_member_id", "=", m.workspaceMemberId)
        .orderBy("member_seq", "asc")
        .execute()
      assert.deepEqual(
        rows.map((r) => Number(r.member_seq)),
        [1, 2, 3],
        "each member has its own contiguous sequence"
      )
    }
  }
)
