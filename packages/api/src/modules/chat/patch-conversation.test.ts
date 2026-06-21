import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { SUBJECT_KIND } from "@synapse/shared"
import type { Kysely } from "kysely"
import { withTestDb, withTestDbAndClient } from "../../test/helpers/db.js"
import type { DatabaseTransaction } from "../../infrastructure/database/kysely.js"
import { upsertAccessSubjectOn } from "../access/subject-registry.js"
import { patchChatConversationUseCase } from "./patch-conversation.js"
import type { ChatConversationRecord } from "./presenter.js"

type AnyDb = Kysely<any>

async function seedPatchConversationFixture(db: AnyDb) {
  const user = await db
    .insertInto("users")
    .values({
      email: `${randomUUID()}@patch-conversation.test`,
      name: "patch conversation user",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const workspace = await db
    .insertInto("workspaces")
    .values({
      ownerId: user.id as string,
      slug: `pc-${randomUUID().slice(0, 8)}`,
      name: "patch conversation workspace",
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
  const subjectId = await upsertAccessSubjectOn(db, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    workspaceMemberId: member.id as string,
  })
  const conversation = await db
    .insertInto("conversations")
    .values({
      workspaceId: workspace.id as string,
      kind: "group",
      title: "before patch",
      metadata: {},
    } as never)
    .returning("id")
    .executeTakeFirstOrThrow()
  const participant = await db
    .insertInto("conversationParticipants")
    .values({
      conversationId: conversation.id as string,
      subjectId,
      roleKey: "owner",
      state: "active",
      metadata: {},
    } as never)
    .returning("id")
    .executeTakeFirstOrThrow()
  await db
    .insertInto("workspaceMemberConversationViews")
    .values({
      workspaceMemberId: member.id as string,
      conversationId: conversation.id as string,
      unreadCount: 0,
    })
    .execute()

  return {
    workspaceId: workspace.id as string,
    workspaceMemberId: member.id as string,
    conversationId: conversation.id as string,
    participantId: participant.id as string,
  }
}

test("patchChatConversationUseCase updates mutable fields and syncs recipients", async () => {
  await withTestDb(async (db) => {
    const fixture = await seedPatchConversationFixture(db as unknown as AnyDb)
    const syncCalls: Array<{
      workspaceId: string
      workspaceMemberIds: string[]
      conversationId: string
    }> = []
    const returnedConversation = {
      conversationId: fixture.conversationId,
      title: "after patch",
      participants: [],
    } as unknown as ChatConversationRecord
    const withTransaction = <T>(fn: (trx: DatabaseTransaction) => Promise<T>) =>
      fn(db as unknown as DatabaseTransaction)

    const result = await patchChatConversationUseCase(
      {
        ...fixture,
        title: "  after patch  ",
        metadata: { topic: "boundary" },
      },
      {
        listConversationRealtimeRecipients: async () => [
          { workspaceMemberId: fixture.workspaceMemberId },
        ],
        loadConversationView: async () => returnedConversation,
        syncConversationUpsert: async (
          _queryable,
          workspaceId,
          workspaceMemberIds,
          conversationId
        ) => {
          syncCalls.push({ workspaceId, workspaceMemberIds, conversationId })
        },
        withTransaction,
      }
    )

    assert.deepEqual(result, { conversation: returnedConversation })
    assert.deepEqual(syncCalls, [
      {
        workspaceId: fixture.workspaceId,
        workspaceMemberIds: [fixture.workspaceMemberId],
        conversationId: fixture.conversationId,
      },
    ])

    const row = await (db as unknown as AnyDb)
      .selectFrom("conversations")
      .select(["title", "metadata"])
      .where("id", "=", fixture.conversationId)
      .executeTakeFirstOrThrow()
    assert.equal(row.title, "after patch")
    assert.deepEqual(row.metadata, { topic: "boundary" })
  })
})

test(
  "patchChatConversationUseCase rolls back mutable fields when sync fails",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const fixture = await seedPatchConversationFixture(db as unknown as AnyDb)

      const withTransaction = async <T>(
        fn: (trx: DatabaseTransaction) => Promise<T>
      ) => {
        await client.query("SAVEPOINT patch_conversation_rollback")
        try {
          const result = await fn(db as unknown as DatabaseTransaction)
          await client.query("RELEASE SAVEPOINT patch_conversation_rollback")
          return result
        } catch (error) {
          await client.query(
            "ROLLBACK TO SAVEPOINT patch_conversation_rollback"
          )
          throw error
        }
      }

      await assert.rejects(
        () =>
          patchChatConversationUseCase(
            {
              ...fixture,
              title: "  should rollback  ",
              metadata: { topic: "rollback" },
            },
            {
              listConversationRealtimeRecipients: async () => [
                { workspaceMemberId: fixture.workspaceMemberId },
              ],
              loadConversationView: async () => {
                throw new Error("view load should not run after sync failure")
              },
              syncConversationUpsert: async () => {
                throw new Error("sync failed")
              },
              withTransaction,
            }
          ),
        /sync failed/
      )

      const row = await (db as unknown as AnyDb)
        .selectFrom("conversations")
        .select(["title", "metadata"])
        .where("id", "=", fixture.conversationId)
        .executeTakeFirstOrThrow()
      assert.equal(row.title, "before patch")
      assert.deepEqual(row.metadata, {})
    })
  }
)
