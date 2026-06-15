import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import {
  CONVERSATION_ITEM_ROLE,
  CONVERSATION_ITEM_SCOPE,
  CONVERSATION_ITEM_SURFACE,
  CONVERSATION_ITEM_TYPE,
  CONVERSATION_MESSAGE_SUBTYPE,
} from "@synapse/shared"
import type { Executor } from "../../infrastructure/database/kysely.js"
import type {
  ChatConversationItemPartRow,
  ChatConversationItemRow,
  ChatConversationParticipantLinkRow,
} from "./repo.js"
import {
  hydrateConversationItemsUseCase,
  type HydrateConversationItemsDeps,
} from "./conversation-item-hydration.js"

function itemRow(values: Partial<ChatConversationItemRow> = {}) {
  return {
    id: randomUUID(),
    conversationId: randomUUID(),
    sessionId: null,
    turnId: null,
    clientMessageId: null,
    scope: CONVERSATION_ITEM_SCOPE.SHARED,
    surface: CONVERSATION_ITEM_SURFACE.VISIBLE,
    itemType: CONVERSATION_ITEM_TYPE.MESSAGE,
    subtype: CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE,
    role: CONVERSATION_ITEM_ROLE.USER,
    authorParticipantId: null,
    replyToItemId: null,
    causedByItemId: null,
    eventPayload: {},
    eventTimelinePolicy: null,
    eventContextPolicy: null,
    metadata: {},
    sequence: 1,
    createdAt: new Date("2026-06-16T00:00:00.000Z"),
    ...values,
  } satisfies ChatConversationItemRow
}

function textPart(
  itemId: string,
  text: string,
  ordinal = 0
): ChatConversationItemPartRow {
  return {
    itemId,
    ordinal,
    partType: "text",
    textValue: text,
    refPath: null,
    refSha256: null,
    jsonValue: null,
    mimeType: null,
    name: null,
    metadata: {},
  }
}

test("hydrateConversationItemsUseCase returns empty without loading related rows", async () => {
  const queryable = {} as Executor
  let called = false
  const deps: HydrateConversationItemsDeps = {
    listConversationItemParts: async () => {
      called = true
      return []
    },
    listConversationItemTargets: async () => {
      called = true
      return []
    },
  }

  const result = await hydrateConversationItemsUseCase(queryable, [], deps)

  assert.deepEqual(result, [])
  assert.equal(called, false)
})

test("hydrateConversationItemsUseCase maps parts and restricted audience by item", async () => {
  const queryable = {} as Executor
  const first = itemRow({
    sequence: "12",
    clientMessageId: randomUUID(),
    metadata: { source: "test" },
    authorParticipantId: randomUUID(),
    replyToItemId: randomUUID(),
    causedByItemId: randomUUID(),
  })
  const second = itemRow({ sequence: 13 })
  const targetId = randomUUID()
  const calls: {
    parts: string[][]
    targets: string[][]
  } = {
    parts: [],
    targets: [],
  }
  const deps: HydrateConversationItemsDeps = {
    listConversationItemParts: async (_queryable, itemIds) => {
      calls.parts.push(itemIds)
      return [
        textPart(second.id, "second item"),
        textPart(first.id, "first "),
        textPart(first.id, "item", 1),
      ]
    },
    listConversationItemTargets: async (_queryable, itemIds) => {
      calls.targets.push(itemIds)
      return [
        {
          itemId: first.id,
          targetParticipantId: targetId,
        } satisfies ChatConversationParticipantLinkRow,
      ]
    },
  }

  const result = await hydrateConversationItemsUseCase(
    queryable,
    [first, second],
    deps
  )

  assert.deepEqual(calls.parts, [[first.id, second.id]])
  assert.deepEqual(calls.targets, [[first.id, second.id]])
  assert.equal(result.length, 2)
  assert.equal(result[0]?.id, first.id)
  assert.equal(result[0]?.sequence, 12)
  assert.equal(result[0]?.clientMessageId, first.clientMessageId)
  assert.equal(result[0]?.authorParticipantId, first.authorParticipantId)
  assert.equal(result[0]?.replyToItemId, first.replyToItemId)
  assert.equal(result[0]?.causedByItemId, first.causedByItemId)
  assert.equal(result[0]?.content, "first item")
  assert.equal(result[0]?.contentBlocks.length, 2)
  assert.equal(result[0]?.contentBlocks[0]?.type, "text")
  assert.deepEqual(result[0]?.restrictedAudienceParticipantIds, [targetId])
  assert.equal(result[0]?.createdAt, "2026-06-16T00:00:00.000Z")
  assert.equal(result[1]?.id, second.id)
  assert.equal(result[1]?.content, "second item")
  assert.deepEqual(result[1]?.restrictedAudienceParticipantIds, [])
})
