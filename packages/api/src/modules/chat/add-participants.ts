import {
  CHAT_MEMBERSHIP_UPDATE_REASON,
  CONVERSATION_PARTICIPANT_STATE,
  CONVERSATION_PARTICIPANT_TYPE,
  type ChatParticipantSummary,
  type ConversationParticipantType,
} from "@synapse/shared"
import type { Executor } from "../../infrastructure/database/kysely.js"
import {
  listActorDisplayNameRows,
  listConversationParticipantStatesByWorkspaceMember,
  listConversationRealtimeRecipientRows,
  listRemoteAgentDisplayNameRows,
  listWorkspaceMemberNameRows,
  upsertWorkspaceMemberConversationView,
  withChatTransaction,
  type ChatParticipantRow,
} from "./repo.js"
import { appendWorkspaceMemberSyncEvent } from "./sync-events.js"
import { requireConversationManagement } from "./conversation-access.js"
import { createChatError } from "./errors.js"
import type {
  ChatConversationEnvelopeRecord,
  ChatConversationRecord,
} from "./presenter.js"
import { getWorkspaceMemberIdentityOrThrow } from "./identity.js"
import {
  ensureConversationParticipantUseCase,
  listConversationParticipantsUseCase,
} from "./participant-roster.js"
import { participantRowToChatParticipantSummary } from "./participant-projection.js"
import { loadChatConversationView } from "./conversation-view-read.js"
import { syncConversationUpsertForWorkspaceMembers } from "./conversation-upsert-sync.js"

type ParticipantKind = ConversationParticipantType

type EnsureConversationParticipant = (params: {
  conversationId: string
  participantType: ParticipantKind
  workspaceMemberId?: string
  actorId?: string
  remoteAgentId?: string
  displayName?: string
  queryable?: Executor
}) => Promise<unknown>

type ListConversationParticipants = (
  conversationId: string,
  options: { queryable: Executor }
) => Promise<ChatParticipantRow[]>

type SyncConversationUpsert = (
  queryable: Executor,
  workspaceId: string,
  workspaceMemberIds: string[],
  conversationId: string
) => Promise<void>

type LoadConversationView = (
  queryable: Executor,
  workspaceId: string,
  workspaceMemberId: string,
  conversationId: string
) => Promise<ChatConversationRecord | null>

export type AddConversationParticipantsInput = {
  workspaceId: string
  conversationId: string
  workspaceMemberIds?: string[]
  actorIds?: string[]
  remoteAgentIds?: string[]
  queryable?: Executor
}

export type AddChatConversationParticipantsInput = Omit<
  AddConversationParticipantsInput,
  "queryable"
> & {
  workspaceMemberId: string
}

export type AddConversationParticipantsDeps = {
  ensureConversationParticipant: EnsureConversationParticipant
  listConversationParticipants: ListConversationParticipants
  participantToSummary: (
    participant: ChatParticipantRow
  ) => ChatParticipantSummary
  syncConversationUpsert: SyncConversationUpsert
}

export type AddChatConversationParticipantsDeps =
  AddConversationParticipantsDeps & {
    loadConversationView: LoadConversationView
  }

async function loadParticipantStatesByMember(
  queryable: Executor,
  conversationId: string,
  workspaceMemberIds: string[]
): Promise<Map<string, string>> {
  const rows = await listConversationParticipantStatesByWorkspaceMember(
    queryable,
    { conversationId, workspaceMemberIds }
  )
  const map = new Map<string, string>()
  for (const row of rows) {
    map.set(row.workspaceMemberId, row.state)
  }
  return map
}

async function listConversationRealtimeRecipients(
  conversationId: string,
  queryable: Executor
) {
  const rows = await listConversationRealtimeRecipientRows(
    queryable,
    conversationId
  )
  return rows.map((row) => ({
    workspaceId: row.workspaceId,
    workspaceMemberId: row.workspaceMemberId,
  }))
}

export async function addConversationParticipantsUseCase(
  params: AddConversationParticipantsInput,
  deps: AddConversationParticipantsDeps
) {
  const executeAdd = async (queryable: Executor) => {
    const workspaceMemberIds = [...new Set(params.workspaceMemberIds ?? [])]
    const actorIds = [...new Set(params.actorIds ?? [])]
    const remoteAgentIds = [...new Set(params.remoteAgentIds ?? [])]

    if (workspaceMemberIds.length > 0) {
      const memberRows = await listWorkspaceMemberNameRows(
        queryable,
        params.workspaceId,
        workspaceMemberIds
      )
      if (memberRows.length !== workspaceMemberIds.length) {
        throw createChatError(
          400,
          "invalid_workspace_member",
          "One or more workspace members are invalid"
        )
      }

      const priorStateByMember = await loadParticipantStatesByMember(
        queryable,
        params.conversationId,
        workspaceMemberIds
      )
      const preExistingRecipients = await listConversationRealtimeRecipients(
        params.conversationId,
        queryable
      )

      for (const member of memberRows) {
        await deps.ensureConversationParticipant({
          conversationId: params.conversationId,
          participantType: CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER,
          workspaceMemberId: member.id,
          displayName: member.userName,
          queryable,
        })
        await upsertWorkspaceMemberConversationView(queryable, {
          workspaceMemberId: member.id,
          conversationId: params.conversationId,
          unreadCount: 0,
        })
      }

      const upsertTargets = [
        ...new Set([
          ...preExistingRecipients.map((r) => r.workspaceMemberId),
          ...workspaceMemberIds,
        ]),
      ]
      await deps.syncConversationUpsert(
        queryable,
        params.workspaceId,
        upsertTargets,
        params.conversationId
      )

      for (const memberId of workspaceMemberIds) {
        const prior = priorStateByMember.get(memberId)
        if (
          prior === CONVERSATION_PARTICIPANT_STATE.REMOVED ||
          prior === CONVERSATION_PARTICIPANT_STATE.LEFT
        ) {
          const activeParticipants = await deps.listConversationParticipants(
            params.conversationId,
            { queryable }
          )
          await appendWorkspaceMemberSyncEvent(queryable, {
            workspaceId: params.workspaceId,
            workspaceMemberId: memberId,
            conversationId: params.conversationId,
            eventType: "conversation.membership.updated",
            payload: {
              conversationId: params.conversationId,
              selfState: CONVERSATION_PARTICIPANT_STATE.ACTIVE,
              reason: CHAT_MEMBERSHIP_UPDATE_REASON.ADDED,
              participants: activeParticipants
                .filter(
                  (p) => p.state === CONVERSATION_PARTICIPANT_STATE.ACTIVE
                )
                .map(deps.participantToSummary),
            },
          })
        }
      }
    }

    if (actorIds.length > 0) {
      const actorRows = await listActorDisplayNameRows(
        queryable,
        params.workspaceId,
        actorIds
      )
      if (actorRows.length !== actorIds.length) {
        throw createChatError(
          400,
          "invalid_actor",
          "One or more actors are invalid"
        )
      }
      for (const actor of actorRows) {
        await deps.ensureConversationParticipant({
          conversationId: params.conversationId,
          participantType: CONVERSATION_PARTICIPANT_TYPE.ACTOR,
          actorId: actor.id,
          displayName: actor.displayName ?? undefined,
          queryable,
        })
      }
    }

    if (remoteAgentIds.length > 0) {
      const remoteAgentRows = await listRemoteAgentDisplayNameRows(
        queryable,
        params.workspaceId,
        remoteAgentIds
      )
      if (remoteAgentRows.length !== remoteAgentIds.length) {
        throw createChatError(
          400,
          "invalid_remote_agent",
          "One or more remote agents are invalid"
        )
      }
      for (const remoteAgent of remoteAgentRows) {
        await deps.ensureConversationParticipant({
          conversationId: params.conversationId,
          participantType: CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT,
          remoteAgentId: remoteAgent.id,
          displayName: remoteAgent.displayName ?? undefined,
          queryable,
        })
      }
    }

    return deps.listConversationParticipants(params.conversationId, {
      queryable,
    })
  }

  if (params.queryable) {
    return executeAdd(params.queryable)
  }
  return withChatTransaction((client) => executeAdd(client))
}

export async function addChatConversationParticipantsUseCase(
  params: AddChatConversationParticipantsInput,
  deps: AddChatConversationParticipantsDeps
): Promise<ChatConversationEnvelopeRecord> {
  return withChatTransaction(async (client) => {
    await requireConversationManagement(
      client,
      params.conversationId,
      params.workspaceMemberId
    )

    await addConversationParticipantsUseCase(
      {
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        workspaceMemberIds: params.workspaceMemberIds,
        actorIds: params.actorIds,
        remoteAgentIds: params.remoteAgentIds,
        queryable: client,
      },
      deps
    )

    const recipients = await listConversationRealtimeRecipients(
      params.conversationId,
      client
    )
    await deps.syncConversationUpsert(
      client,
      params.workspaceId,
      recipients.map((r) => r.workspaceMemberId),
      params.conversationId
    )

    const conversation = await deps.loadConversationView(
      client,
      params.workspaceId,
      params.workspaceMemberId,
      params.conversationId
    )
    if (!conversation) {
      throw createChatError(
        404,
        "conversation_not_found",
        "Conversation not found"
      )
    }
    return { conversation }
  })
}

function chatAddParticipantsDeps(): AddChatConversationParticipantsDeps {
  return {
    ensureConversationParticipant: ensureConversationParticipantUseCase,
    listConversationParticipants: listConversationParticipantsUseCase,
    loadConversationView: loadChatConversationView,
    participantToSummary: participantRowToChatParticipantSummary,
    syncConversationUpsert: syncConversationUpsertForWorkspaceMembers,
  }
}

export async function addConversationParticipants(
  params: AddConversationParticipantsInput
) {
  return addConversationParticipantsUseCase(params, chatAddParticipantsDeps())
}

export async function addChatConversationParticipants(params: {
  workspaceId: string
  userId: string
  conversationId: string
  workspaceMemberIds?: string[]
  actorIds?: string[]
  remoteAgentIds?: string[]
}): Promise<ChatConversationEnvelopeRecord> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  return addChatConversationParticipantsUseCase(
    {
      workspaceId: params.workspaceId,
      workspaceMemberId: identity.workspaceMemberId,
      conversationId: params.conversationId,
      workspaceMemberIds: params.workspaceMemberIds,
      actorIds: params.actorIds,
      remoteAgentIds: params.remoteAgentIds,
    },
    chatAddParticipantsDeps()
  )
}
