import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import {
  CONVERSATION_ITEM_SCOPE,
  CONVERSATION_ITEM_SURFACE,
  CONVERSATION_PARTICIPANT_ROLE_KEY,
  CONVERSATION_PARTICIPANT_STATE,
  CONVERSATION_PARTICIPANT_TYPE,
  mentionBlock,
} from "@synapse/shared"
import type { Executor } from "../../infrastructure/database/kysely.js"
import { prepareConversationItemWrite } from "./conversation-item-write-prep.js"
import type { ChatParticipantRow } from "./repo.js"

const JOINED_AT = new Date("2026-06-16T00:00:00.000Z")

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
    joinedAt: JOINED_AT,
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

test("prepareConversationItemWrite canonicalizes mention parts", async () => {
  const conversationId = randomUUID()
  const workspaceMemberId = randomUUID()
  const target = participant({
    id: randomUUID(),
    conversationId,
    workspaceMemberId,
    userName: "Mention Target",
  })
  const mention = mentionBlock({
    mention: {
      participantType: CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER,
      workspaceMemberId,
    },
  })

  const prepared = await prepareConversationItemWrite({} as Executor, {
    conversationId,
    scope: CONVERSATION_ITEM_SCOPE.SHARED,
    surface: CONVERSATION_ITEM_SURFACE.VISIBLE,
    activeParticipants: [target],
    parts: [
      { type: "text", text: "hello" },
      {
        type: "json",
        json: mention,
        metadata: { source: "test" },
      },
    ],
    restrictedAudienceParticipantIds: [target.id],
    contextTargetParticipantIds: [target.id],
  })

  assert.deepEqual(prepared.mentionedParticipants, [
    { participantId: target.id, ordinal: 1 },
  ])
  assert.equal(prepared.replyToItem, null)
  assert.equal(prepared.parts[0]?.type, "text")

  const mentionPart = prepared.parts[1]
  assert.equal(mentionPart?.type, "json")
  assert.equal(
    (mentionPart?.metadata?.mention as { participantId?: string })
      .participantId,
    target.id
  )
  assert.equal(
    (mentionPart?.json as { mention?: { participantId?: string } })?.mention
      ?.participantId,
    target.id
  )
})

test("prepareConversationItemWrite rejects invalid target participants", async () => {
  const conversationId = randomUUID()
  const target = participant({
    id: randomUUID(),
    conversationId,
  })
  const invalid = randomUUID()

  await assert.rejects(
    prepareConversationItemWrite({} as Executor, {
      conversationId,
      scope: CONVERSATION_ITEM_SCOPE.SHARED,
      surface: CONVERSATION_ITEM_SURFACE.VISIBLE,
      activeParticipants: [target],
      parts: [],
      restrictedAudienceParticipantIds: [invalid],
    }),
    /Invalid restricted audience participant/
  )

  await assert.rejects(
    prepareConversationItemWrite({} as Executor, {
      conversationId,
      scope: CONVERSATION_ITEM_SCOPE.SHARED,
      surface: CONVERSATION_ITEM_SURFACE.VISIBLE,
      activeParticipants: [target],
      parts: [],
      contextTargetParticipantIds: [invalid],
    }),
    /Invalid context target participant/
  )
})
