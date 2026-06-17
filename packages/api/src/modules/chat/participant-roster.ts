import {
  CONVERSATION_PARTICIPANT_ROLE_KEY,
  CONVERSATION_PARTICIPANT_TYPE,
  SUBJECT_KIND,
  type ConversationParticipantType,
} from "@synapse/shared"
import type { Executor } from "../../infrastructure/database/kysely.js"
import { upsertAccessSubjectOn } from "../access/subject-registry.js"
import {
  chatRootExecutor,
  conversationParticipantExists,
  getConversationParticipantStateBySubject,
  getConversationRecord,
  getTransportAddressSubjectRow,
  insertConversationParticipantRecord,
  listChatConversationParticipantRows,
  reactivateConversationParticipant,
  upsertConversationParticipantAddress,
} from "./repo.js"

type ParticipantKind = ConversationParticipantType

function rootQueryable(): Executor {
  return chatRootExecutor()
}

/**
 * Resolve the access_subjects.id for a participant of the given kind, minting
 * the subject if needed. Insert and ensure both use this so dedup is keyed on
 * (conversation_id, subject_id), not display name.
 */
async function resolveParticipantSubjectId(
  queryable: Executor,
  params: {
    participantType: ParticipantKind
    workspaceMemberId?: string
    actorId?: string
    remoteAgentId?: string
    transportAddressId?: string
  }
): Promise<string> {
  if (
    params.participantType === CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER &&
    params.workspaceMemberId
  ) {
    return upsertAccessSubjectOn(queryable, {
      kind: SUBJECT_KIND.WORKSPACE_MEMBER,
      memberId: params.workspaceMemberId,
    })
  }
  if (
    params.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR &&
    params.actorId
  ) {
    return upsertAccessSubjectOn(queryable, {
      kind: SUBJECT_KIND.ACTOR,
      actorId: params.actorId,
    })
  }
  if (
    params.participantType === CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT &&
    params.remoteAgentId
  ) {
    return upsertAccessSubjectOn(queryable, {
      kind: SUBJECT_KIND.REMOTE_AGENT,
      remoteAgentId: params.remoteAgentId,
    })
  }

  if (!params.transportAddressId) {
    throw new Error(
      "resolveParticipantSubjectId: external participant requires transportAddressId"
    )
  }
  const addr = await getTransportAddressSubjectRow(
    queryable,
    params.transportAddressId
  )
  if (!addr) {
    throw new Error(
      `resolveParticipantSubjectId: transport_addresses(${params.transportAddressId}) not found`
    )
  }
  if (addr.addressType !== "user") {
    throw new Error(
      `resolveParticipantSubjectId: address ${params.transportAddressId} is not a user address`
    )
  }
  if (addr.workspaceMemberId) {
    throw new Error(
      `resolveParticipantSubjectId: address ${params.transportAddressId} is linked to a workspace member; add it as a member, not an external participant`
    )
  }
  return upsertAccessSubjectOn(queryable, {
    kind: SUBJECT_KIND.EXTERNAL,
    workspaceId: addr.workspaceId,
    transportAddressId: params.transportAddressId,
  })
}

export async function insertParticipant(
  queryable: Executor,
  params: {
    conversationId: string
    participantType: ParticipantKind
    workspaceMemberId?: string
    actorId?: string
    remoteAgentId?: string
    actorJoinVersionId?: string
    displayName?: string
    roleKey: string
    metadata?: Record<string, unknown>
    // External participant identity: mints the subject and links the address.
    transportAddressId?: string
    // Optional pre-resolved subject id so ensure + insert agree without
    // resolving twice.
    subjectId?: string
  }
) {
  const participantId = crypto.randomUUID()
  const participantSubjectId =
    params.subjectId ?? (await resolveParticipantSubjectId(queryable, params))
  await insertConversationParticipantRecord(queryable, {
    participantId,
    conversationId: params.conversationId,
    subjectId: participantSubjectId,
    actorJoinVersionId: params.actorJoinVersionId,
    displayName: params.displayName,
    roleKey: params.roleKey,
    metadata: params.metadata,
    transportAddressId: params.transportAddressId,
  })

  return {
    id: participantId,
  }
}

export async function listConversationParticipantsUseCase(
  conversationId: string,
  options?: { useProfileSnapshot?: boolean; queryable?: Executor }
) {
  return listChatConversationParticipantRows(
    options?.queryable ?? rootQueryable(),
    [conversationId],
    { useProfileSnapshot: options?.useProfileSnapshot }
  )
}

export async function getConversationParticipantUseCase(params: {
  conversationId: string
  participantId?: string
  actorId?: string
  remoteAgentId?: string
  workspaceMemberId?: string
  transportAddressId?: string
  queryable?: Executor
}) {
  const queryable = params.queryable ?? rootQueryable()
  if (params.participantId) {
    const exists = await conversationParticipantExists(queryable, {
      conversationId: params.conversationId,
      participantId: params.participantId,
    })
    if (!exists) {
      return null
    }
  }

  const participants = await listConversationParticipantsUseCase(
    params.conversationId,
    {
      queryable,
    }
  )
  return (
    participants.find((participant) =>
      params.participantId
        ? participant.id === params.participantId
        : params.actorId
          ? participant.actorId === params.actorId
          : params.remoteAgentId
            ? participant.remoteAgentId === params.remoteAgentId
            : params.workspaceMemberId
              ? participant.workspaceMemberId === params.workspaceMemberId
              : params.transportAddressId
                ? participant.transportAddressId === params.transportAddressId
                : false
    ) ?? null
  )
}

export async function ensureConversationParticipantUseCase(params: {
  conversationId: string
  participantType: ParticipantKind
  workspaceMemberId?: string
  actorId?: string
  remoteAgentId?: string
  displayName?: string
  actorJoinVersionId?: string
  roleKey?: string
  metadata?: Record<string, unknown>
  transportAddressId?: string
  queryable?: Executor
}) {
  const queryable = params.queryable ?? rootQueryable()
  const conversation = await getConversationRecord(
    queryable,
    params.conversationId
  )
  if (!conversation) {
    throw new Error("Conversation not found")
  }

  if (
    params.participantType === CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER &&
    !params.workspaceMemberId
  ) {
    throw new Error("workspaceMemberId is required for workspace participants")
  }
  if (
    params.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR &&
    !params.actorId
  ) {
    throw new Error("actorId is required for actor participants")
  }
  if (
    params.participantType === CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT &&
    !params.remoteAgentId
  ) {
    throw new Error("remoteAgentId is required for remote agent participants")
  }

  const targetSubjectId = await resolveParticipantSubjectId(queryable, {
    participantType: params.participantType,
    workspaceMemberId: params.workspaceMemberId,
    actorId: params.actorId,
    remoteAgentId: params.remoteAgentId,
    transportAddressId: params.transportAddressId,
  })

  const existing = await getConversationParticipantStateBySubject(queryable, {
    conversationId: params.conversationId,
    subjectId: targetSubjectId,
  })

  const existingId = existing?.id
  if (existingId) {
    await reactivateConversationParticipant(queryable, {
      participantId: existingId,
      actorJoinVersionId: params.actorJoinVersionId,
      displayName: params.displayName,
      roleKey: params.roleKey ?? CONVERSATION_PARTICIPANT_ROLE_KEY.MEMBER,
      metadata: params.metadata,
    })

    if (params.transportAddressId) {
      await upsertConversationParticipantAddress(
        queryable,
        existingId,
        params.transportAddressId
      )
    }

    return getConversationParticipantUseCase({
      conversationId: params.conversationId,
      participantId: existingId,
      queryable,
    })
  }

  const inserted = await insertParticipant(queryable, {
    conversationId: params.conversationId,
    participantType: params.participantType,
    workspaceMemberId: params.workspaceMemberId,
    actorId: params.actorId,
    remoteAgentId: params.remoteAgentId,
    actorJoinVersionId: params.actorJoinVersionId,
    displayName: params.displayName,
    roleKey: params.roleKey ?? CONVERSATION_PARTICIPANT_ROLE_KEY.MEMBER,
    metadata: params.metadata,
    transportAddressId: params.transportAddressId,
    subjectId: targetSubjectId,
  })

  return getConversationParticipantUseCase({
    conversationId: params.conversationId,
    participantId: inserted.id,
    queryable,
  })
}
