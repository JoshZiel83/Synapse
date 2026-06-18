import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import {
  buildConversationMessageRef,
  CONVERSATION_ITEM_ROLE,
  CONVERSATION_ITEM_SCOPE,
  CONVERSATION_ITEM_SURFACE,
  CONVERSATION_ITEM_TYPE,
  CONVERSATION_MESSAGE_SUBTYPE,
  CONVERSATION_PARTICIPANT_ROLE_KEY,
  CONVERSATION_PARTICIPANT_STATE,
  CONVERSATION_PARTICIPANT_TYPE,
  CONVERSATION_REPLY_REF_SPECIAL_SUBTYPE,
} from "@synapse/shared"
import { dateToIsoInstant } from "@synapse/shared/datetime"
import type { HydratedConversationItemRecord } from "./conversation-item-hydration.js"
import {
  buildConversationReplyRefs,
  resolveConversationReplyRef,
  unavailableConversationReplyRef,
} from "./conversation-reply-ref.js"
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
    itemType: row.itemType,
    role: row.role,
    subtype: row.subtype,
    scope: row.scope,
    surface: row.surface,
    authorParticipantId: row.authorParticipantId ?? undefined,
    replyToItemId: row.replyToItemId ?? undefined,
    causedByItemId: row.causedByItemId ?? undefined,
    content: "Reply text",
    contentBlocks: [{ id: randomUUID(), type: "text", text: "Reply text" }],
    metadata: row.metadata,
    restrictedAudienceParticipantIds: [],
    createdAt: dateToIsoInstant(row.createdAt),
    ...values,
  }
}

test("buildConversationReplyRefs maps visible shared reply rows", () => {
  const conversationId = randomUUID()
  const author = participant({
    id: randomUUID(),
    conversationId,
    workspaceMemberId: randomUUID(),
    userName: "Reply Author",
  })
  const row = itemRow({
    id: randomUUID(),
    conversationId,
    authorParticipantId: author.id,
    sequence: "42",
  })
  const contentBlocks = [
    { id: randomUUID(), type: "text" as const, text: "Reply text" },
  ]

  const refs = buildConversationReplyRefs({
    replyToIds: [row.id],
    replyRows: [row],
    replyHydratedItems: [
      hydratedItem(row, {
        content: "  Reply text  ",
        contentBlocks,
      }),
    ],
    participantById: new Map([[author.id, author]]),
  })

  const ref = refs.get(row.id)
  assert.ok(ref)
  assert.equal(ref.itemId, row.id)
  assert.equal(ref.ref, buildConversationMessageRef(42))
  assert.equal(ref.sequence, 42)
  assert.equal(ref.itemType, CONVERSATION_ITEM_TYPE.MESSAGE)
  assert.equal(ref.subtype, CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE)
  assert.equal(ref.author?.participantId, author.id)
  assert.equal(ref.author?.name, "Reply Author")
  assert.equal(ref.previewText, "Reply text")
  assert.deepEqual(ref.previewBlocks, contentBlocks)
  assert.equal(ref.createdAt, CREATED_AT.toISOString())
})

test("buildConversationReplyRefs ignores missing, unhydrated, and non-visible replies", () => {
  const conversationId = randomUUID()
  const privateRow = itemRow({
    id: randomUUID(),
    conversationId,
    scope: CONVERSATION_ITEM_SCOPE.PRIVATE,
  })
  const internalRow = itemRow({
    id: randomUUID(),
    conversationId,
    surface: CONVERSATION_ITEM_SURFACE.INTERNAL,
  })
  const unhydratedRow = itemRow({
    id: randomUUID(),
    conversationId,
  })

  const refs = buildConversationReplyRefs({
    replyToIds: ["missing", privateRow.id, internalRow.id, unhydratedRow.id],
    replyRows: [privateRow, internalRow, unhydratedRow],
    replyHydratedItems: [hydratedItem(privateRow), hydratedItem(internalRow)],
    participantById: new Map(),
  })

  assert.equal(refs.size, 0)
})

test("unavailableConversationReplyRef returns the shared unavailable shape", () => {
  const itemId = randomUUID()

  assert.deepEqual(unavailableConversationReplyRef(itemId), {
    itemId,
    itemType: CONVERSATION_ITEM_TYPE.MESSAGE,
    subtype: CONVERSATION_REPLY_REF_SPECIAL_SUBTYPE.UNAVAILABLE,
    previewText: "",
    previewBlocks: [],
    isUnavailable: true,
  })
})

test("resolveConversationReplyRef returns null when replyRef is absent", async () => {
  const resolved = await resolveConversationReplyRef({
    conversationId: randomUUID(),
  })

  assert.equal(resolved, null)
})

test("resolveConversationReplyRef rejects malformed refs before querying", async () => {
  await assert.rejects(
    () =>
      resolveConversationReplyRef({
        conversationId: randomUUID(),
        replyRef: "not-a-message-ref",
      }),
    (error) => {
      assert.equal((error as { statusCode?: unknown }).statusCode, 400)
      assert.equal((error as { code?: unknown }).code, "invalid_reply_ref")
      assert.match(
        (error as { message?: string }).message ?? "",
        /replyToRef must use/
      )
      return true
    }
  )
})
