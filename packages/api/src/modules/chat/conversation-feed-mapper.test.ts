import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import {
  CONVERSATION_ITEM_ROLE,
  CONVERSATION_ITEM_SCOPE,
  CONVERSATION_ITEM_SURFACE,
  CONVERSATION_ITEM_TYPE,
  CONVERSATION_MESSAGE_SUBTYPE,
  CONVERSATION_MESSAGE_TRANSPORT_DIRECTION,
  CONVERSATION_PARTICIPANT_ROLE_KEY,
  CONVERSATION_PARTICIPANT_STATE,
  CONVERSATION_PARTICIPANT_TYPE,
  TRANSPORT_KINDS,
} from "@synapse/shared"
import { assertIsoInstantString } from "@synapse/shared/datetime"
import type { ConversationMessageTransportDelivery } from "@synapse/shared/types"
import type {
  ConversationEventItemDetail,
  ConversationItemDetail,
} from "./conversation-item-detail.js"
import type { ChatParticipantRow } from "./repo.js"
import { conversationItemDetailToFeedItem } from "./conversation-feed-mapper.js"

const CREATED_AT = assertIsoInstantString("2026-06-16T00:00:00.000Z")
const TRANSPORT_KIND = TRANSPORT_KINDS[0]

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
    joinedAt: new Date(CREATED_AT),
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

function messageDetail(
  values: Partial<ConversationItemDetail> = {}
): ConversationItemDetail {
  const conversationId = randomUUID()
  const author = participant({
    id: randomUUID(),
    conversationId,
    workspaceMemberId: randomUUID(),
    userName: "Author",
  })
  return {
    id: randomUUID(),
    conversationId,
    sequence: 9,
    scope: CONVERSATION_ITEM_SCOPE.SHARED,
    surface: CONVERSATION_ITEM_SURFACE.VISIBLE,
    role: CONVERSATION_ITEM_ROLE.TOOL,
    itemType: CONVERSATION_ITEM_TYPE.MESSAGE,
    subtype: CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE,
    authorParticipantId: author.id,
    authorParticipant: author,
    restrictedAudienceParticipants: [],
    contextTargets: [],
    contentBlocks: [{ id: randomUUID(), type: "text", text: "Mapped body" }],
    metadata: {},
    createdAt: CREATED_AT,
    ...values,
  } as ConversationItemDetail
}

test("conversationItemDetailToFeedItem maps message details to feed messages", () => {
  const restricted = participant({
    id: randomUUID(),
    conversationId: randomUUID(),
    workspaceMemberId: randomUUID(),
    userName: "Restricted",
  })
  const delivery: ConversationMessageTransportDelivery = {
    linkId: randomUUID(),
    transportKind: TRANSPORT_KIND,
    direction: CONVERSATION_MESSAGE_TRANSPORT_DIRECTION.OUTBOUND,
    deliveryStatus: "sent",
    endpointType: "direct",
    metadata: {},
  }
  const item = conversationItemDetailToFeedItem(
    messageDetail({
      restrictedAudienceParticipants: [restricted],
      metadata: {
        transport: {
          direction: CONVERSATION_MESSAGE_TRANSPORT_DIRECTION.OUTBOUND,
          transportKind: TRANSPORT_KIND,
          endpointType: "direct",
          externalMessageId: "external-1",
        },
      },
    }),
    [delivery]
  )

  assert.equal(item.kind, "message")
  assert.equal(item.role, "system")
  assert.equal(item.content, "Mapped body")
  assert.equal(item.messageType, CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE)
  assert.equal(item.restrictedAudience?.[0]?.participantId, restricted.id)
  assert.equal(item.transport?.transportKind, TRANSPORT_KIND)
  assert.equal(item.transport?.externalMessageId, "external-1")
  assert.deepEqual(item.transportDeliveries, [delivery])
})

test("conversationItemDetailToFeedItem maps event details to feed events", () => {
  const conversationId = randomUUID()
  const actor = participant({
    id: randomUUID(),
    conversationId,
    workspaceMemberId: randomUUID(),
    userName: "Actor",
  })
  const detail: ConversationEventItemDetail<"participant_joined"> = {
    id: randomUUID(),
    conversationId,
    sequence: 10,
    scope: CONVERSATION_ITEM_SCOPE.SHARED,
    surface: CONVERSATION_ITEM_SURFACE.VISIBLE,
    role: CONVERSATION_ITEM_ROLE.SYSTEM,
    itemType: CONVERSATION_ITEM_TYPE.EVENT,
    subtype: "participant_joined",
    eventPayload: {
      batchId: randomUUID(),
      participants: [
        {
          participantId: actor.id,
          participantType: CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER,
          workspaceMemberId: actor.workspaceMemberId ?? undefined,
          name: "Actor",
        },
      ],
    },
    authorParticipant: actor,
    restrictedAudienceParticipants: [actor],
    contextTargets: [],
    contentBlocks: [],
    metadata: {},
    causedByItemId: "cause-1",
    createdAt: CREATED_AT,
  }

  const item = conversationItemDetailToFeedItem(detail)

  assert.equal(item.kind, "event")
  assert.equal(item.eventType, "participant_joined")
  assert.equal(item.author?.participantId, actor.id)
  assert.equal(item.restrictedAudience?.[0]?.participantId, actor.id)
  assert.equal(item.causedByItemId, "cause-1")
  assert.deepEqual(item.payload, detail.eventPayload)
})
