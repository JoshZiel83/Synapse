import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import {
  CONVERSATION_PARTICIPANT_ROLE_KEY,
  CONVERSATION_PARTICIPANT_STATE,
  CONVERSATION_PARTICIPANT_TYPE,
  TRANSPORT_KINDS,
} from "@synapse/shared"
import type { ChatParticipantRow } from "./repo.js"
import {
  participantDisplayName,
  participantRowToChatParticipantSummary,
  participantRowToEntityRef,
} from "./participant-projection.js"

const JOINED_AT = new Date("2026-06-16T00:00:00.000Z")
const LEFT_AT = new Date("2026-06-16T01:00:00.000Z")
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

test("participantDisplayName keeps participant-type-specific priorities", () => {
  assert.equal(
    participantDisplayName(
      participant({
        id: randomUUID(),
        conversationId: randomUUID(),
        userName: "  Workspace User  ",
        displayName: "Display fallback",
      })
    ),
    "Workspace User"
  )
  assert.equal(
    participantDisplayName(
      participant({
        id: randomUUID(),
        conversationId: randomUUID(),
        participantType: CONVERSATION_PARTICIPANT_TYPE.EXTERNAL,
        transportDisplayName: "Transport User",
        displayName: "Display User",
      })
    ),
    "Transport User"
  )
  assert.equal(
    participantDisplayName(
      participant({
        id: randomUUID(),
        conversationId: randomUUID(),
      })
    ),
    "Unknown"
  )
})

test("participantRowToEntityRef maps external identity and avatar fields", () => {
  const fileId = randomUUID()
  const row = participant({
    id: randomUUID(),
    conversationId: randomUUID(),
    participantType: CONVERSATION_PARTICIPANT_TYPE.EXTERNAL,
    participantRole: "guest",
    participantTitle: "Visitor",
    transportAddressId: randomUUID(),
    transportKind: TRANSPORT_KIND,
    transportExternalId: "external-1",
    transportDisplayName: "External Person",
    participantAvatarFileId: fileId,
    participantAvatarEmoji: "robot",
  })

  const entity = participantRowToEntityRef(row)

  assert.equal(entity?.participantId, row.id)
  assert.equal(entity?.participantType, CONVERSATION_PARTICIPANT_TYPE.EXTERNAL)
  assert.equal(entity?.externalUserKey, `${TRANSPORT_KIND}:external-1`)
  assert.equal(entity?.transportKind, TRANSPORT_KIND)
  assert.equal(entity?.transportAddressId, row.transportAddressId)
  assert.equal(entity?.name, "External Person")
  assert.equal(entity?.title, "Visitor")
  assert.equal(entity?.role, "guest")
  assert.equal(entity?.avatarUrl, `/api/v1/files/${fileId}`)
  assert.equal(entity?.avatarEmoji, "robot")
})

test("participantRowToChatParticipantSummary maps summary timestamps and optional ids", () => {
  const row = participant({
    id: randomUUID(),
    conversationId: randomUUID(),
    workspaceMemberId: randomUUID(),
    userName: "Member",
    leftAt: LEFT_AT,
    sessionId: randomUUID(),
    sessionStatus: "running",
    metadata: { muted: true },
  })

  const summary = participantRowToChatParticipantSummary(row)

  assert.equal(summary.participantId, row.id)
  assert.equal(summary.conversationId, row.conversationId)
  assert.equal(
    summary.participantType,
    CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER
  )
  assert.equal(summary.workspaceMemberId, row.workspaceMemberId)
  assert.equal(summary.name, "Member")
  assert.equal(summary.roleKey, CONVERSATION_PARTICIPANT_ROLE_KEY.MEMBER)
  assert.equal(summary.state, CONVERSATION_PARTICIPANT_STATE.ACTIVE)
  assert.deepEqual(summary.metadata, { muted: true })
  assert.equal(summary.joinedAt, JOINED_AT.toISOString())
  assert.equal(summary.leftAt, LEFT_AT.toISOString())
  assert.equal(summary.sessionId, row.sessionId)
  assert.equal(summary.sessionStatus, "running")
})
