import { randomUUID } from "node:crypto"
import {
  CONVERSATION_KINDS,
  CONVERSATION_PARTICIPANT_ROLE_KEY,
  CONVERSATION_PARTICIPANT_TYPE,
} from "@synapse/shared"
import type { Executor } from "../../infrastructure/database/kysely.js"
import {
  chatRootExecutor,
  getChatConversationCreateRequestConversationId,
  insertChatConversationCreateRequest,
  insertConversationRecord,
  listActorDisplayNameRows,
  listRemoteAgentDisplayNameRows,
  listWorkspaceMemberNameRows,
  upsertWorkspaceMemberConversationView,
  withChatTransaction,
} from "./repo.js"
import { createChatError } from "./errors.js"
import type {
  ChatConversationCreateRecord,
  ChatConversationRecord,
} from "./presenter.js"

type ConversationKind = (typeof CONVERSATION_KINDS)[number]

type InsertParticipant = (
  queryable: Executor,
  params: {
    conversationId: string
    participantType: (typeof CONVERSATION_PARTICIPANT_TYPE)[keyof typeof CONVERSATION_PARTICIPANT_TYPE]
    workspaceMemberId?: string
    actorId?: string
    remoteAgentId?: string
    displayName?: string
    roleKey: string
    metadata?: Record<string, unknown>
  }
) => Promise<unknown>

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

export type CreateChatConversationInput = {
  workspaceId: string
  creatorWorkspaceMemberId: string
  clientRequestId: string
  kind: ConversationKind
  title?: string
  workspaceMemberIds?: string[]
  actorIds?: string[]
  remoteAgentIds?: string[]
  metadata?: Record<string, unknown>
  queryable?: Executor
}

export type CreateChatConversationDeps = {
  insertParticipant: InsertParticipant
  loadConversationView: LoadConversationView
  syncConversationUpsert: SyncConversationUpsert
}

export async function createChatConversationUseCase(
  params: CreateChatConversationInput,
  deps: CreateChatConversationDeps
): Promise<ChatConversationCreateRecord> {
  const workspaceMemberIds = [
    ...new Set([
      params.creatorWorkspaceMemberId,
      ...(params.workspaceMemberIds ?? []),
    ]),
  ]
  const actorIds = [...new Set(params.actorIds ?? [])]
  const remoteAgentIds = [...new Set(params.remoteAgentIds ?? [])]

  const executeCreate = async (client: Executor) => {
    const existingConversationId =
      await getChatConversationCreateRequestConversationId(client, {
        workspaceMemberId: params.creatorWorkspaceMemberId,
        clientRequestId: params.clientRequestId,
      })
    if (existingConversationId) {
      return existingConversationId
    }

    const memberRows = await listWorkspaceMemberNameRows(
      client,
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

    const actorRows = await listActorDisplayNameRows(
      client,
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

    const remoteAgentRows = await listRemoteAgentDisplayNameRows(
      client,
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

    const newConversationId = randomUUID()
    await insertConversationRecord(client, {
      conversationId: newConversationId,
      kind: params.kind,
      workspaceId: params.workspaceId,
      title: params.title,
      createdByWorkspaceMemberId: params.creatorWorkspaceMemberId,
      metadata: params.metadata,
    })

    for (const member of memberRows) {
      await deps.insertParticipant(client, {
        conversationId: newConversationId,
        participantType: CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER,
        workspaceMemberId: member.id,
        displayName: member.userName,
        roleKey:
          member.id === params.creatorWorkspaceMemberId
            ? CONVERSATION_PARTICIPANT_ROLE_KEY.OWNER
            : CONVERSATION_PARTICIPANT_ROLE_KEY.MEMBER,
        metadata: {},
      })
      await upsertWorkspaceMemberConversationView(client, {
        workspaceMemberId: member.id,
        conversationId: newConversationId,
        unreadCount: 0,
      })
    }

    for (const actor of actorRows) {
      await deps.insertParticipant(client, {
        conversationId: newConversationId,
        participantType: CONVERSATION_PARTICIPANT_TYPE.ACTOR,
        actorId: actor.id,
        displayName: actor.displayName ?? undefined,
        roleKey: CONVERSATION_PARTICIPANT_ROLE_KEY.MEMBER,
        metadata: {},
      })
    }

    for (const remoteAgent of remoteAgentRows) {
      await deps.insertParticipant(client, {
        conversationId: newConversationId,
        participantType: CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT,
        remoteAgentId: remoteAgent.id,
        displayName: remoteAgent.displayName ?? undefined,
        roleKey: CONVERSATION_PARTICIPANT_ROLE_KEY.MEMBER,
        metadata: {},
      })
    }

    await insertChatConversationCreateRequest(client, {
      workspaceMemberId: params.creatorWorkspaceMemberId,
      clientRequestId: params.clientRequestId,
      workspaceId: params.workspaceId,
      conversationId: newConversationId,
    })

    await deps.syncConversationUpsert(
      client,
      params.workspaceId,
      memberRows.map((row) => row.id),
      newConversationId
    )

    return newConversationId
  }

  const conversationId = params.queryable
    ? await executeCreate(params.queryable)
    : await withChatTransaction(executeCreate)

  const conversation = await deps.loadConversationView(
    params.queryable ?? chatRootExecutor(),
    params.workspaceId,
    params.creatorWorkspaceMemberId,
    conversationId
  )

  if (!conversation) {
    throw createChatError(
      500,
      "conversation_load_failed",
      "Failed to load created conversation"
    )
  }

  return { conversation }
}
