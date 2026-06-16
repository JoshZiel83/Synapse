import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import {
  CONVERSATION_EVENT_CONTEXT_POLICY,
  CONVERSATION_EVENT_TIMELINE_POLICY,
  CONVERSATION_FEED_MESSAGE_TYPE,
  CONVERSATION_ITEM_ROLE,
  CONVERSATION_ITEM_SCOPE,
  CONVERSATION_ITEM_SURFACE,
  CONVERSATION_ITEM_TYPE,
  CONVERSATION_MESSAGE_SUBTYPE,
  CONVERSATION_PARTICIPANT_ROLE_KEY,
  CONVERSATION_PARTICIPANT_STATE,
  CONVERSATION_PARTICIPANT_TYPE,
  CONVERSATION_REPLY_REF_SPECIAL_SUBTYPE,
  type ConversationReplyRef,
} from "@synapse/shared"
import type { HydratedConversationItemRecord } from "./conversation-item-hydration.js"
import { buildConversationItemDetail } from "./conversation-item-detail-builder.js"
import type { ChatConversationItemRow, ChatParticipantRow } from "./repo.js"

const CREATED_AT = new Date("2026-06-16T00:00:00.000Z")

function participant(
  values: Pick<ChatParticipantRow, "id" | "conversationId"> &
    Partial<ChatParticipantRow>
): ChatParticipantRow {
  return {
    participantType: CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER,
    workspaceMemberId: null,
    actorId: null,
    remoteAgentId: null,
    actorJoinVersionId: null,
    displayName: null,
    roleKey: CONVERSATION_PARTICIPANT_ROLE_KEY.MEMBER,
    state: CONVERSATION_PARTICIPANT_STATE.ACTIVE,
    metadata: {},
    joinedAt: CREATED_AT,
    leftAt: null,
    userId: null,
    userName: null,
    participantName: null,
    participantTitle: null,
    participantRole: null,
    actorDocs: null,
    actorCanRepresentUser: null,
    actorSpecialties: null,
    actorConfig: null,
    actorCurrentVersion: null,
    participantAvatarEmoji: null,
    participantAvatarFileId: null,
    userAvatarFileId: null,
    transportAddressId: null,
    transportKind: null,
    transportExternalId: null,
    transportDisplayName: null,
    linkedUserId: null,
    linkedUserName: null,
    linkedUserAvatarFileId: null,
    sessionId: null,
    sessionStatus: null,
    ...values,
  }
}

function itemRow(
  values: Pick<ChatConversationItemRow, "id" | "conversationId"> &
    Partial<ChatConversationItemRow>
): ChatConversationItemRow {
  return {
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
    createdAt: CREATED_AT,
    ...values,
  }
}

function hydratedItem(
  row: ChatConversationItemRow,
  values: Partial<HydratedConversationItemRecord> = {}
): HydratedConversationItemRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    sequence:
      typeof row.sequence === "number" ? row.sequence : Number(row.sequence),
    clientMessageId: row.clientMessageId ?? undefined,
    itemType: row.itemType,
    role: row.role,
    subtype: row.subtype,
    scope: row.scope,
    surface: row.surface,
    authorParticipantId: row.authorParticipantId ?? undefined,
    replyToItemId: row.replyToItemId ?? undefined,
    causedByItemId: row.causedByItemId ?? undefined,
    content: "Message body",
    contentBlocks: [{ id: randomUUID(), type: "text", text: "Message body" }],
    metadata: row.metadata,
    restrictedAudienceParticipantIds: [],
    createdAt: row.createdAt.toISOString(),
    ...values,
  }
}

test("buildConversationItemDetail maps message base fields", () => {
  const conversationId = randomUUID()
  const author = participant({
    id: randomUUID(),
    conversationId,
    workspaceMemberId: randomUUID(),
    userName: "Author",
  })
  const restricted = participant({
    id: randomUUID(),
    conversationId,
    userName: "Restricted",
  })
  const contextTarget = participant({
    id: randomUUID(),
    conversationId,
    userName: "Context Target",
  })
  const replyToItemId = randomUUID()
  const replyRef = {
    itemId: replyToItemId,
    itemType: CONVERSATION_ITEM_TYPE.MESSAGE,
    subtype: CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE,
    previewText: "quoted",
    previewBlocks: [],
  } satisfies ConversationReplyRef
  const row = itemRow({
    id: randomUUID(),
    conversationId,
    sessionId: randomUUID(),
    turnId: randomUUID(),
    clientMessageId: "client-1",
    authorParticipantId: author.id,
    replyToItemId,
    causedByItemId: randomUUID(),
    metadata: { transport: { endpointType: "direct" } },
    sequence: "7",
  })

  const detail = buildConversationItemDetail({
    row,
    hydrated: hydratedItem(row, {
      restrictedAudienceParticipantIds: [restricted.id, "missing"],
    }),
    participantById: new Map([
      [author.id, author],
      [restricted.id, restricted],
      [contextTarget.id, contextTarget],
    ]),
    contextTargetIdsByItem: new Map([[row.id, [contextTarget.id, "missing"]]]),
    replyRefById: new Map([[replyToItemId, replyRef]]),
  })

  assert.equal(detail.id, row.id)
  assert.equal(detail.sequence, 7)
  assert.equal(detail.itemType, CONVERSATION_ITEM_TYPE.MESSAGE)
  assert.equal(detail.subtype, CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE)
  assert.equal(detail.authorParticipant?.id, author.id)
  assert.deepEqual(
    detail.restrictedAudienceParticipants.map((participant) => participant.id),
    [restricted.id]
  )
  assert.deepEqual(
    detail.contextTargets.map((participant) => participant.id),
    [contextTarget.id]
  )
  assert.equal(detail.replyTo, replyRef)
  assert.equal(detail.createdAt, CREATED_AT.toISOString())
  assert.equal(detail.clientMessageId, "client-1")
})

test("buildConversationItemDetail uses unavailable fallback for missing reply refs", () => {
  const row = itemRow({
    id: randomUUID(),
    conversationId: randomUUID(),
    replyToItemId: randomUUID(),
  })

  const detail = buildConversationItemDetail({
    row,
    hydrated: hydratedItem(row),
    participantById: new Map(),
    contextTargetIdsByItem: new Map(),
    replyRefById: new Map(),
  })

  assert.equal(detail.replyTo?.itemId, row.replyToItemId)
  assert.equal(
    detail.replyTo?.subtype,
    CONVERSATION_REPLY_REF_SPECIAL_SUBTYPE.UNAVAILABLE
  )
  assert.equal(detail.replyTo?.isUnavailable, true)
})

test("buildConversationItemDetail maps event payload and policies", () => {
  const payload = { batchId: randomUUID(), participants: [] }
  const row = itemRow({
    id: randomUUID(),
    conversationId: randomUUID(),
    itemType: CONVERSATION_ITEM_TYPE.EVENT,
    subtype: "participant_joined",
    eventPayload: payload,
    eventTimelinePolicy: CONVERSATION_EVENT_TIMELINE_POLICY.ALL_MEMBERS,
    eventContextPolicy: CONVERSATION_EVENT_CONTEXT_POLICY.SHARED,
  })

  const detail = buildConversationItemDetail({
    row,
    hydrated: hydratedItem(row, { contentBlocks: [] }),
    participantById: new Map(),
    contextTargetIdsByItem: new Map(),
    replyRefById: new Map(),
  })

  assert.equal(detail.itemType, CONVERSATION_ITEM_TYPE.EVENT)
  if (detail.itemType !== CONVERSATION_ITEM_TYPE.EVENT) {
    throw new Error("Expected event detail")
  }
  assert.equal(detail.subtype, "participant_joined")
  assert.deepEqual(detail.eventPayload, payload)
  assert.equal(
    detail.eventTimelinePolicy,
    CONVERSATION_EVENT_TIMELINE_POLICY.ALL_MEMBERS
  )
  assert.equal(
    detail.eventContextPolicy,
    CONVERSATION_EVENT_CONTEXT_POLICY.SHARED
  )
})

test("buildConversationItemDetail validates event payload by subtype", () => {
  const row = itemRow({
    id: randomUUID(),
    conversationId: randomUUID(),
    itemType: CONVERSATION_ITEM_TYPE.EVENT,
    subtype: "participant_joined",
    eventPayload: { batchId: randomUUID() },
  })

  assert.throws(() =>
    buildConversationItemDetail({
      row,
      hydrated: hydratedItem(row, { contentBlocks: [] }),
      participantById: new Map(),
      contextTargetIdsByItem: new Map(),
      replyRefById: new Map(),
    })
  )
})

test("buildConversationItemDetail rejects invalid event and summary subtypes", () => {
  const conversationId = randomUUID()
  const eventRow = itemRow({
    id: randomUUID(),
    conversationId,
    itemType: CONVERSATION_ITEM_TYPE.EVENT,
    subtype: "not_an_event",
  })

  assert.throws(
    () =>
      buildConversationItemDetail({
        row: eventRow,
        hydrated: hydratedItem(eventRow),
        participantById: new Map(),
        contextTargetIdsByItem: new Map(),
        replyRefById: new Map(),
      }),
    /Unsupported conversation event subtype/
  )

  const summaryRow = itemRow({
    id: randomUUID(),
    conversationId,
    itemType: CONVERSATION_ITEM_TYPE.SUMMARY,
    subtype: CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE,
  })
  assert.throws(
    () =>
      buildConversationItemDetail({
        row: summaryRow,
        hydrated: hydratedItem(summaryRow, {
          subtype: CONVERSATION_FEED_MESSAGE_TYPE.SUMMARY,
        }),
        participantById: new Map(),
        contextTargetIdsByItem: new Map(),
        replyRefById: new Map(),
      }),
    /Unsupported conversation summary subtype/
  )
})
