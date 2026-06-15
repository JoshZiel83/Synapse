import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { Kysely } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import type { DatabaseTransaction } from "../../infrastructure/database/kysely.js"
import {
  updateChatConversationReadWatermarkUseCase,
  type SyncConversationUpsert,
} from "./read-watermark.js"
import {
  __resetChatDedupCountersForTests,
  getChatDedupCountersSnapshot,
} from "./observability.js"

type AnyDb = Kysely<any>

async function seedReadWatermarkFixture(db: AnyDb) {
  const user = await db
    .insertInto("users")
    .values({
      email: `${randomUUID()}@read-watermark.test`,
      name: "read watermark user",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const workspace = await db
    .insertInto("workspaces")
    .values({
      ownerId: user.id as string,
      slug: `rw-${randomUUID().slice(0, 8)}`,
      name: "read watermark workspace",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const member = await db
    .insertInto("workspaceMembers")
    .values({
      workspaceId: workspace.id as string,
      userId: user.id as string,
      trustLevel: "member",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const subjectId = randomUUID()
  await db
    .insertInto("accessSubjects")
    .values({
      id: subjectId,
      kind: "workspace_member",
      workspaceId: workspace.id as string,
      workspaceMemberId: member.id as string,
    })
    .execute()
  const conversation = await db
    .insertInto("conversations")
    .values({
      workspaceId: workspace.id as string,
      kind: "direct",
      title: "read watermark conversation",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const participant = await db
    .insertInto("conversationParticipants")
    .values({
      conversationId: conversation.id as string,
      subjectId,
      displayName: "Reader",
      roleKey: "owner",
      state: "active",
      metadata: {},
    } as never)
    .returning("id")
    .executeTakeFirstOrThrow()
  await db
    .insertInto("conversationParticipantStates")
    .values({
      conversationId: conversation.id as string,
      participantId: participant.id as string,
      readWatermarkSequence: 0,
    })
    .execute()
  await db
    .insertInto("workspaceMemberConversationViews")
    .values({
      workspaceMemberId: member.id as string,
      conversationId: conversation.id as string,
      unreadCount: 0,
    })
    .execute()
  const clientInstanceId = randomUUID()
  await db
    .insertInto("chatClientInstances")
    .values({
      id: clientInstanceId,
      workspaceId: workspace.id as string,
      workspaceMemberId: member.id as string,
      platform: "test",
      status: "active",
      metadata: {},
    } as never)
    .execute()

  return {
    workspaceId: workspace.id as string,
    workspaceMemberId: member.id as string,
    conversationId: conversation.id as string,
    participantId: participant.id as string,
    clientInstanceId,
  }
}

test("read-watermark coordinator preserves duplicate heuristic and sync dependency", async () => {
  __resetChatDedupCountersForTests()

  await withTestDb(async (db) => {
    const fixture = await seedReadWatermarkFixture(db as unknown as AnyDb)
    const syncCalls: Array<{
      workspaceId: string
      workspaceMemberIds: string[]
      conversationId: string
    }> = []
    const syncConversationUpsert: SyncConversationUpsert = async (
      _queryable,
      workspaceId,
      workspaceMemberIds,
      conversationId
    ) => {
      syncCalls.push({ workspaceId, workspaceMemberIds, conversationId })
    }
    const withTransaction = <T>(fn: (trx: DatabaseTransaction) => Promise<T>) =>
      fn(db as unknown as DatabaseTransaction)

    const first = await updateChatConversationReadWatermarkUseCase(
      {
        ...fixture,
        readUpToSequence: 0,
        lastVisibleSequence: 0,
      },
      { syncConversationUpsert, withTransaction }
    )
    assert.equal(first.readWatermarkSequence, 0)
    assert.equal(first.participantId, fixture.participantId)
    assert.equal(
      getChatDedupCountersSnapshot().duplicate_watermark_post_total ?? 0,
      0,
      "initial sequence=0 mark must not count as duplicate"
    )

    await updateChatConversationReadWatermarkUseCase(
      {
        ...fixture,
        readUpToSequence: 0,
        lastVisibleSequence: 0,
      },
      { syncConversationUpsert, withTransaction }
    )
    assert.equal(
      getChatDedupCountersSnapshot().duplicate_watermark_post_total,
      1,
      "second no-op mark should count as duplicate"
    )
    assert.deepEqual(syncCalls, [
      {
        workspaceId: fixture.workspaceId,
        workspaceMemberIds: [fixture.workspaceMemberId],
        conversationId: fixture.conversationId,
      },
      {
        workspaceId: fixture.workspaceId,
        workspaceMemberIds: [fixture.workspaceMemberId],
        conversationId: fixture.conversationId,
      },
    ])

    const events = await (db as unknown as AnyDb)
      .selectFrom("workspaceMemberSyncEvents")
      .select(["eventType", "memberSeq"])
      .where("workspaceMemberId", "=", fixture.workspaceMemberId)
      .orderBy("memberSeq", "asc")
      .execute()
    assert.deepEqual(
      events.map((event) => ({
        eventType: event.eventType,
        memberSeq: Number(event.memberSeq),
      })),
      [
        { eventType: "conversation.read.updated", memberSeq: 1 },
        { eventType: "conversation.read.updated", memberSeq: 2 },
      ]
    )
  })
})
