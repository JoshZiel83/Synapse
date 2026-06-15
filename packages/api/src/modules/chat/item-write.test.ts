import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import {
  CONVERSATION_ITEM_SCOPE,
  CONVERSATION_ITEM_SURFACE,
  CONVERSATION_ITEM_TYPE,
  CONVERSATION_MESSAGE_SUBTYPE,
  type ChatConversationItem,
} from "@synapse/shared"
import type { Kysely } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import {
  createConversationItemUseCase,
  sendConversationMessageFromParticipantUseCase,
} from "./item-write.js"
import type { ChatConversationItemRow, ChatParticipantRow } from "./repo.js"

type AnyDb = Kysely<any>

async function seedItemWriteFixture(db: AnyDb) {
  const user = await db
    .insertInto("users")
    .values({
      email: `${randomUUID()}@item-write.test`,
      name: "item writer",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const workspace = await db
    .insertInto("workspaces")
    .values({
      ownerId: user.id as string,
      slug: `iw-${randomUUID().slice(0, 8)}`,
      name: "item write workspace",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const conversation = await db
    .insertInto("conversations")
    .values({
      workspaceId: workspace.id as string,
      kind: "group",
      title: "item write conversation",
    })
    .returning("id")
    .executeTakeFirstOrThrow()

  return {
    workspaceId: workspace.id as string,
    conversationId: conversation.id as string,
  }
}

function itemFromRow(row: ChatConversationItemRow): ChatConversationItem {
  return {
    id: row.id,
    conversationId: row.conversationId,
    sequence: Number(row.sequence),
    itemType: CONVERSATION_ITEM_TYPE.MESSAGE,
    subtype: CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE,
    role: row.role,
    scope: row.scope,
    surface: row.surface,
    content: "hello",
    contentBlocks: [{ id: randomUUID(), type: "text", text: "hello" }],
    metadata: row.metadata,
    createdAt: "2026-06-15T00:00:00.000Z",
  } as ChatConversationItem
}

test("createConversationItemUseCase inserts details and runs visible side effects", async () => {
  await withTestDb(async (db) => {
    const fixture = await seedItemWriteFixture(db as unknown as AnyDb)
    const activeParticipant = {
      id: randomUUID(),
      conversationId: fixture.conversationId,
      state: "active",
      workspaceMemberId: randomUUID(),
    } as ChatParticipantRow
    const syncCalls: Array<{
      conversationId: string
      itemId: string
      activeParticipantIds: string[]
    }> = []
    const deliveryCalls: Array<{
      conversationId: string
      itemId: string
      workspaceId?: string
    }> = []

    const item = await createConversationItemUseCase(
      {
        workspaceId: fixture.workspaceId,
        conversationId: fixture.conversationId,
        scope: CONVERSATION_ITEM_SCOPE.SHARED,
        surface: CONVERSATION_ITEM_SURFACE.VISIBLE,
        itemType: CONVERSATION_ITEM_TYPE.MESSAGE,
        subtype: CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE,
        role: "user",
        metadata: { source: "test" },
        parts: [{ type: "text", text: "hello" }],
        queryable: db as unknown as AnyDb,
      },
      {
        prepareConversationItemWrite: async () => ({
          activeParticipants: [activeParticipant],
          parts: [{ type: "text", text: "hello" }],
          mentionedParticipants: [],
          replyToItem: null,
        }),
        buildChatConversationItems: async (_queryable, rows) =>
          rows.map(itemFromRow),
        syncVisibleSharedItem: async (params) => {
          syncCalls.push({
            conversationId: params.conversationId,
            itemId: params.item.id,
            activeParticipantIds: params.activeParticipants.map((p) => p.id),
          })
        },
        createRemoteAgentDeliveriesForItem: async (params) => {
          deliveryCalls.push({
            conversationId: params.conversationId,
            itemId: params.itemId,
            workspaceId: params.workspaceId,
          })
        },
      }
    )

    assert.equal(item.conversationId, fixture.conversationId)
    assert.equal(item.content, "hello")

    const rows = await (db as unknown as AnyDb)
      .selectFrom("conversationItems")
      .select(["id", "conversationId", "metadata"])
      .where("conversationId", "=", fixture.conversationId)
      .execute()
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.id, item.id)
    assert.deepEqual(rows[0]!.metadata, { source: "test" })

    const parts = await (db as unknown as AnyDb)
      .selectFrom("conversationItemParts")
      .select(["itemId", "partType", "textValue"])
      .where("itemId", "=", item.id)
      .execute()
    assert.deepEqual(parts, [
      {
        itemId: item.id,
        partType: "text",
        textValue: "hello",
      },
    ])

    assert.deepEqual(syncCalls, [
      {
        conversationId: fixture.conversationId,
        itemId: item.id,
        activeParticipantIds: [activeParticipant.id],
      },
    ])
    assert.deepEqual(deliveryCalls, [
      {
        conversationId: fixture.conversationId,
        itemId: item.id,
        workspaceId: fixture.workspaceId,
      },
    ])
  })
})

test("sendConversationMessageFromParticipantUseCase defers wakeups inside caller transactions", async () => {
  const item = {
    id: randomUUID(),
    conversationId: randomUUID(),
    sequence: 1,
    itemType: CONVERSATION_ITEM_TYPE.MESSAGE,
    subtype: CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE,
    role: "user",
    scope: CONVERSATION_ITEM_SCOPE.SHARED,
    surface: CONVERSATION_ITEM_SURFACE.VISIBLE,
    content: "hello",
    contentBlocks: [{ id: randomUUID(), type: "text", text: "hello" }],
    metadata: {},
    createdAt: "2026-06-15T00:00:00.000Z",
  } as ChatConversationItem
  const createCalls: unknown[] = []
  const wakeCalls: unknown[] = []
  const notifyCalls: string[] = []

  const result = await sendConversationMessageFromParticipantUseCase(
    {
      workspaceId: randomUUID(),
      conversationId: item.conversationId,
      senderParticipantId: randomUUID(),
      contentBlocks: [{ id: randomUUID(), type: "text", text: "hello" }],
      queryable: {} as never,
    },
    {
      createConversationItem: async (params) => {
        createCalls.push(params)
        return item
      },
      enqueueActorWakeupsForConversationMessage: async (params) => {
        wakeCalls.push(params)
      },
      notifyRemoteAgentDeliveriesForConversation: async (conversationId) => {
        notifyCalls.push(conversationId)
      },
    }
  )

  assert.equal(result, item)
  assert.equal(createCalls.length, 1)
  assert.deepEqual(wakeCalls, [])
  assert.deepEqual(notifyCalls, [])
})

test("sendConversationMessageFromParticipantUseCase wakes and notifies after standalone sends", async () => {
  const workspaceId = randomUUID()
  const conversationId = randomUUID()
  const item = {
    id: randomUUID(),
    conversationId,
    sequence: 1,
    itemType: CONVERSATION_ITEM_TYPE.MESSAGE,
    subtype: CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE,
    role: "user",
    scope: CONVERSATION_ITEM_SCOPE.SHARED,
    surface: CONVERSATION_ITEM_SURFACE.VISIBLE,
    content: "hello",
    contentBlocks: [{ id: randomUUID(), type: "text", text: "hello" }],
    metadata: {},
    createdAt: "2026-06-15T00:00:00.000Z",
  } as ChatConversationItem
  const wakeCalls: unknown[] = []
  const notifyCalls: string[] = []

  await sendConversationMessageFromParticipantUseCase(
    {
      workspaceId,
      conversationId,
      senderParticipantId: randomUUID(),
      contentBlocks: [{ id: randomUUID(), type: "text", text: "hello" }],
    },
    {
      createConversationItem: async () => item,
      enqueueActorWakeupsForConversationMessage: async (params) => {
        wakeCalls.push(params)
      },
      notifyRemoteAgentDeliveriesForConversation: async (id) => {
        notifyCalls.push(id)
      },
    }
  )

  assert.deepEqual(wakeCalls, [
    {
      workspaceId,
      conversationId,
      itemId: item.id,
    },
  ])
  assert.deepEqual(notifyCalls, [conversationId])
})
