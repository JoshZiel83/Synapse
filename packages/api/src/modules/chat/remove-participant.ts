import {
  CHAT_MEMBERSHIP_UPDATE_REASON,
  CHAT_PARTICIPANT_REMOVAL_STATE,
  CONVERSATION_FEED_EVENT_TYPE,
  CONVERSATION_PARTICIPANT_STATE,
  type ChatParticipantRemovalState,
  type ChatParticipantSummary,
  type ConversationParticipantType,
} from "@synapse/shared"
import type { ConversationFeedEventPayloadMap } from "@synapse/shared/types"
import type {
  DatabaseTransaction,
  Executor,
} from "../../infrastructure/database/kysely.js"
import {
  chatRootExecutor,
  getConversationParticipantById,
  updateConversationParticipantState,
  withChatTransaction,
  type ChatParticipantRow,
} from "./repo.js"
import {
  requireConversationAccess,
  requireConversationManagement,
} from "./conversation-access.js"
import { appendWorkspaceMemberSyncEventInTransaction } from "./sync-events.js"
import { createChatError } from "./errors.js"

type ParticipantKind = ConversationParticipantType
type RemovalEventType =
  | typeof CONVERSATION_FEED_EVENT_TYPE.PARTICIPANT_LEFT
  | typeof CONVERSATION_FEED_EVENT_TYPE.PARTICIPANT_KICKED
type RemovalEventPayload =
  | ConversationFeedEventPayloadMap["participant_left"]
  | ConversationFeedEventPayloadMap["participant_kicked"]

export type ChatParticipantRemovalRecord = {
  conversationId: string
  participantId: string
  state: ChatParticipantRemovalState
}

export type SyncConversationUpsert = (
  queryable: Executor,
  workspaceId: string,
  workspaceMemberIds: string[],
  conversationId: string
) => Promise<void>

type CreateRemovalConversationEvent = (params: {
  workspaceId: string
  conversationId: string
  eventType: RemovalEventType
  authorParticipantId: string
  eventPayload: RemovalEventPayload
  queryable: Executor
}) => Promise<unknown>

type ListConversationParticipants = (
  conversationId: string,
  options: { queryable: Executor }
) => Promise<ChatParticipantRow[]>

type ListRealtimeRecipients = (
  conversationId: string,
  queryable: Executor
) => Promise<Array<{ workspaceMemberId: string }>>

type RunRemoveParticipantTransaction = <T>(
  fn: (trx: DatabaseTransaction) => Promise<T>
) => Promise<T>

type RequireConversationAccess = (
  queryable: Executor,
  conversationId: string,
  workspaceMemberId: string
) => Promise<{
  participant: {
    id: string
    participantType: ConversationParticipantType
    userName?: string | null
  }
}>

export type RemoveParticipantInput = {
  workspaceId: string
  workspaceMemberId: string
  conversationId: string
  participantId: string
}

export type RemoveParticipantDeps = {
  createRemovalConversationEvent: CreateRemovalConversationEvent
  listConversationParticipants: ListConversationParticipants
  listConversationRealtimeRecipients: ListRealtimeRecipients
  participantToSummary: (
    participant: ChatParticipantRow
  ) => ChatParticipantSummary
  requireConversationAccess?: RequireConversationAccess
  syncConversationUpsert: SyncConversationUpsert
  withTransaction?: RunRemoveParticipantTransaction
}

export type LeaveConversationInput = {
  workspaceId: string
  workspaceMemberId: string
  conversationId: string
}

async function setParticipantState(
  queryable: Executor,
  participantId: string,
  state: ChatParticipantRemovalState
) {
  await updateConversationParticipantState(queryable, participantId, state)
}

export async function loadParticipantById(
  queryable: Executor,
  conversationId: string,
  participantId: string
) {
  return getConversationParticipantById(queryable, {
    conversationId,
    participantId,
  })
}

export async function removeChatConversationParticipantUseCase(
  params: RemoveParticipantInput,
  deps: RemoveParticipantDeps
): Promise<ChatParticipantRemovalRecord> {
  const withTransaction = deps.withTransaction ?? withChatTransaction
  const loadAccess = deps.requireConversationAccess ?? requireConversationAccess
  return withTransaction(async (client) => {
    const access = await loadAccess(
      client,
      params.conversationId,
      params.workspaceMemberId
    )

    const target = await loadParticipantById(
      client,
      params.conversationId,
      params.participantId
    )
    if (!target) {
      throw createChatError(
        404,
        "participant_not_found",
        "Participant not found in this conversation"
      )
    }
    if (target.state !== CONVERSATION_PARTICIPANT_STATE.ACTIVE) {
      throw createChatError(
        409,
        "participant_not_active",
        "Participant is already left or removed"
      )
    }

    const isSelfRemoval = target.id === access.participant.id
    // Kicking someone else requires management rights; leaving only requires
    // being an active participant.
    if (!isSelfRemoval) {
      await requireConversationManagement(
        client,
        params.conversationId,
        params.workspaceMemberId
      )
    }

    const eventType: RemovalEventType = isSelfRemoval
      ? CONVERSATION_FEED_EVENT_TYPE.PARTICIPANT_LEFT
      : CONVERSATION_FEED_EVENT_TYPE.PARTICIPANT_KICKED
    const removalState = isSelfRemoval
      ? CHAT_PARTICIPANT_REMOVAL_STATE.LEFT
      : CHAT_PARTICIPANT_REMOVAL_STATE.REMOVED

    await setParticipantState(client, target.id, removalState)

    await deps.createRemovalConversationEvent({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      eventType,
      authorParticipantId: access.participant.id,
      eventPayload: {
        batchId: crypto.randomUUID(),
        initiator: isSelfRemoval
          ? undefined
          : {
              participantId: access.participant.id,
              participantType: access.participant
                .participantType as ParticipantKind,
              workspaceMemberId: params.workspaceMemberId,
            },
        participants: [
          {
            participantId: target.id,
            participantType: target.participantType as Exclude<
              ParticipantKind,
              "system"
            >,
            workspaceMemberId: target.workspaceMemberId ?? undefined,
            actorId: target.actorId ?? undefined,
            remoteAgentId: target.remoteAgentId ?? undefined,
            name: target.displayName ?? undefined,
          },
        ],
      },
      queryable: client,
    })

    const recipients = await deps.listConversationRealtimeRecipients(
      params.conversationId,
      client
    )
    // Remaining active members get conversation.upsert; the removed member gets
    // an explicit tombstone event because loadConversationView now excludes
    // them after the state transition.
    await deps.syncConversationUpsert(
      client,
      params.workspaceId,
      recipients.map((r) => r.workspaceMemberId),
      params.conversationId
    )

    if (target.workspaceMemberId) {
      const activeParticipants = await deps.listConversationParticipants(
        params.conversationId,
        { queryable: client }
      )
      await appendWorkspaceMemberSyncEventInTransaction(client, {
        workspaceId: params.workspaceId,
        workspaceMemberId: target.workspaceMemberId,
        conversationId: params.conversationId,
        eventType: "conversation.membership.updated",
        payload: {
          conversationId: params.conversationId,
          selfState: removalState,
          reason: isSelfRemoval
            ? CHAT_MEMBERSHIP_UPDATE_REASON.LEFT
            : CHAT_MEMBERSHIP_UPDATE_REASON.KICKED,
          participants: activeParticipants
            .filter((p) => p.state === CONVERSATION_PARTICIPANT_STATE.ACTIVE)
            .map(deps.participantToSummary),
        },
      })
    }

    return {
      conversationId: params.conversationId,
      participantId: target.id,
      state: removalState,
    }
  })
}

export async function leaveChatConversationUseCase(
  params: LeaveConversationInput,
  deps: RemoveParticipantDeps
): Promise<ChatParticipantRemovalRecord> {
  const loadAccess = deps.requireConversationAccess ?? requireConversationAccess
  const access = await loadAccess(
    chatRootExecutor(),
    params.conversationId,
    params.workspaceMemberId
  )
  return removeChatConversationParticipantUseCase(
    {
      workspaceId: params.workspaceId,
      workspaceMemberId: params.workspaceMemberId,
      conversationId: params.conversationId,
      participantId: access.participant.id,
    },
    deps
  )
}
