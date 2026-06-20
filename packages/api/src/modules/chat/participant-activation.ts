import crypto from "node:crypto"
import {
  CONVERSATION_PARTICIPANT_STATE,
  CONVERSATION_PARTICIPANT_TYPE,
} from "@synapse/shared"
import type { Executor } from "../../infrastructure/database/kysely.js"
import { createConversationEvent } from "./event-write.js"
import {
  ensureConversationParticipantUseCase as ensureConversationParticipant,
  getConversationParticipantUseCase as getConversationParticipant,
} from "./participant-roster.js"

type ParticipantInitiator = {
  participantType: "actor" | "remote_agent" | "workspace_member"
  participantId?: string
  workspaceMemberId?: string
  actorId?: string
  remoteAgentId?: string
  name?: string
}

async function resolveInitiator(params: {
  conversationId: string
  initiator?: ParticipantInitiator
  queryable?: Executor
}) {
  if (!params.initiator) {
    return undefined
  }
  if (params.initiator.participantId) {
    return params.initiator
  }
  const participant = await getConversationParticipant({
    conversationId: params.conversationId,
    workspaceMemberId: params.initiator.workspaceMemberId,
    actorId: params.initiator.actorId,
    remoteAgentId: params.initiator.remoteAgentId,
    queryable: params.queryable,
  })
  if (!participant) {
    return params.initiator
  }
  return {
    ...params.initiator,
    participantId: participant.id,
  }
}

function defaultParticipantName(
  participantType: "actor" | "remote_agent" | "workspace_member" | "external"
) {
  switch (participantType) {
    case CONVERSATION_PARTICIPANT_TYPE.ACTOR:
      return "Actor"
    case CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT:
      return "Remote Agent"
    case CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER:
      return "User"
    default:
      return "External participant"
  }
}

async function loadParticipantDisplay(params: {
  participantType: "actor" | "remote_agent" | "workspace_member" | "external"
  actorId?: string
  workspaceMemberId?: string
  displayName?: string
}) {
  if (params.displayName?.trim()) {
    return {
      name: params.displayName.trim(),
      title: undefined as string | undefined,
    }
  }
  return {
    name: defaultParticipantName(params.participantType),
    title: undefined as string | undefined,
  }
}

export async function activateConversationParticipant(params: {
  workspaceId?: string
  conversationId: string
  participantType: "actor" | "workspace_member" | "external"
  workspaceMemberId?: string
  actorId?: string
  remoteAgentId?: string
  displayName?: string
  actorJoinVersionId?: string
  metadata?: Record<string, unknown>
  // Required for external participants: the transport address that identifies
  // this external person (used to mint the first-class subject).
  transportAddressId?: string
  initiator?: ParticipantInitiator
  recordJoinEvent?: boolean
  queryable?: Executor
}) {
  const existing = await getConversationParticipant({
    conversationId: params.conversationId,
    workspaceMemberId: params.workspaceMemberId,
    actorId: params.actorId,
    remoteAgentId: params.remoteAgentId,
    // External participants have no member/actor/agent id — they are identified
    // by their transport address. Without this an existing external participant
    // is never found, so every IM inbound would re-fire participant_joined.
    transportAddressId: params.transportAddressId,
    queryable: params.queryable,
  })
  const activated =
    !existing || existing.state !== CONVERSATION_PARTICIPANT_STATE.ACTIVE
  const created = !existing
  const revived = Boolean(
    existing && existing.state !== CONVERSATION_PARTICIPANT_STATE.ACTIVE
  )

  const member = await ensureConversationParticipant({
    conversationId: params.conversationId,
    participantType: params.participantType,
    workspaceMemberId: params.workspaceMemberId,
    actorId: params.actorId,
    remoteAgentId: params.remoteAgentId,
    displayName: params.displayName,
    actorJoinVersionId: params.actorJoinVersionId,
    metadata: params.metadata,
    transportAddressId: params.transportAddressId,
    queryable: params.queryable,
  })

  if (!member) {
    throw new Error("Failed to activate conversation participant")
  }

  if (activated && params.recordJoinEvent !== false) {
    const initiator = await resolveInitiator({
      conversationId: params.conversationId,
      initiator: params.initiator,
      queryable: params.queryable,
    })
    const { name, title } = await loadParticipantDisplay({
      participantType: params.participantType,
      actorId: params.actorId,
      workspaceMemberId: params.workspaceMemberId,
      displayName: params.displayName,
    })

    await createConversationEvent({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      eventType: "participant_joined",
      timelinePolicy: "all_members",
      contextPolicy: "shared",
      authorParticipantId:
        initiator?.participantType === params.participantType
          ? member.id
          : initiator?.participantId,
      eventPayload: {
        batchId: crypto.randomUUID(),
        participants: [
          {
            participantId: member.id,
            participantType: params.participantType,
            actorId: params.actorId,
            remoteAgentId: params.remoteAgentId,
            workspaceMemberId: params.workspaceMemberId,
            name,
            title,
          },
        ],
        initiator: initiator
          ? {
              participantId: initiator.participantId,
              participantType: initiator.participantType,
              actorId: initiator.actorId,
              remoteAgentId: initiator.remoteAgentId,
              workspaceMemberId: initiator.workspaceMemberId,
              name: initiator.name,
            }
          : undefined,
      },
      queryable: params.queryable,
    })
  }

  return {
    member,
    activated,
    created,
    revived,
  }
}
