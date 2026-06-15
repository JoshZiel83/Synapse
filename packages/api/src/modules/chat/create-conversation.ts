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
  insertConversationRecordReturning,
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
type ParticipantType =
  (typeof CONVERSATION_PARTICIPANT_TYPE)[keyof typeof CONVERSATION_PARTICIPANT_TYPE]

type InsertParticipant = (
  queryable: Executor,
  params: {
    conversationId: string
    participantType: ParticipantType
    workspaceMemberId?: string
    actorId?: string
    remoteAgentId?: string
    displayName?: string
    roleKey: string
    metadata?: Record<string, unknown>
  }
) => Promise<unknown>

type EnsureConversationParticipant = (params: {
  conversationId: string
  participantType: ParticipantType
  workspaceMemberId?: string
  actorId?: string
  remoteAgentId?: string
  displayName?: string
  roleKey?: string
  queryable?: Executor
}) => Promise<unknown>

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

export type CreateConversationForWorkspaceMemberInput = {
  workspaceId: string
  creatorWorkspaceMemberId?: string
  kind: ConversationKind
  title?: string
  workspaceMemberIds?: string[]
  actorIds?: string[]
  remoteAgentIds?: string[]
  metadata?: Record<string, unknown>
  queryable?: Executor
}

export type CreateConversationInput = {
  kind: ConversationKind
  workspaceId: string
  title?: string
  createdByWorkspaceMemberId?: string
  metadata?: Record<string, unknown>
  queryable?: Executor
}

export type CreateChatConversationDeps = {
  insertParticipant: InsertParticipant
  loadConversationView: LoadConversationView
  syncConversationUpsert: SyncConversationUpsert
}

export type CreateConversationForWorkspaceMemberDeps = {
  ensureConversationParticipant: EnsureConversationParticipant
  syncConversationUpsert: SyncConversationUpsert
}

export async function createConversationRecordUseCase(
  params: CreateConversationInput
) {
  const queryable = params.queryable ?? chatRootExecutor()
  if (!params.workspaceId) {
    throw new Error("createConversation: workspaceId is required")
  }
  const id = randomUUID()
  return insertConversationRecordReturning(queryable, {
    conversationId: id,
    kind: params.kind,
    workspaceId: params.workspaceId,
    title: params.title,
    createdByWorkspaceMemberId: params.createdByWorkspaceMemberId,
    metadata: params.metadata,
  })
}

export async function createConversationForWorkspaceMemberUseCase(
  params: CreateConversationForWorkspaceMemberInput,
  deps: CreateConversationForWorkspaceMemberDeps
) {
  const executeCreate = async (queryable: Executor) => {
    const workspaceMemberIds = [
      ...new Set(
        [
          ...(params.creatorWorkspaceMemberId
            ? [params.creatorWorkspaceMemberId]
            : []),
          ...(params.workspaceMemberIds ?? []),
        ].filter(Boolean)
      ),
    ]
    const actorIds = [...new Set(params.actorIds ?? [])]
    const remoteAgentIds = [...new Set(params.remoteAgentIds ?? [])]

    // Validate every participant before inserting the conversation so a rejected
    // request never leaves an orphan row when the caller passes its own queryable.
    // External participants are minted only by the IM ingest path.
    const memberRows =
      workspaceMemberIds.length > 0
        ? await listWorkspaceMemberNameRows(
            queryable,
            params.workspaceId,
            workspaceMemberIds
          )
        : []
    if (memberRows.length !== workspaceMemberIds.length) {
      throw createChatError(
        400,
        "invalid_workspace_member",
        "One or more workspace members are invalid"
      )
    }

    const actorRows =
      actorIds.length > 0
        ? await listActorDisplayNameRows(
            queryable,
            params.workspaceId,
            actorIds
          )
        : []
    if (actorRows.length !== actorIds.length) {
      throw createChatError(
        400,
        "invalid_actor",
        "One or more actors are invalid"
      )
    }

    const remoteAgentRows =
      remoteAgentIds.length > 0
        ? await listRemoteAgentDisplayNameRows(
            queryable,
            params.workspaceId,
            remoteAgentIds
          )
        : []
    if (remoteAgentRows.length !== remoteAgentIds.length) {
      throw createChatError(
        400,
        "invalid_remote_agent",
        "One or more remote agents are invalid"
      )
    }

    const conversation = await createConversationRecordUseCase({
      kind: params.kind,
      workspaceId: params.workspaceId,
      title: params.title,
      createdByWorkspaceMemberId: params.creatorWorkspaceMemberId,
      metadata: params.metadata,
      queryable,
    })

    for (const member of memberRows) {
      await deps.ensureConversationParticipant({
        conversationId: conversation.id as string,
        participantType: CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER,
        workspaceMemberId: member.id,
        displayName: member.userName,
        roleKey:
          member.id === params.creatorWorkspaceMemberId
            ? CONVERSATION_PARTICIPANT_ROLE_KEY.OWNER
            : CONVERSATION_PARTICIPANT_ROLE_KEY.MEMBER,
        queryable,
      })
      await upsertWorkspaceMemberConversationView(queryable, {
        workspaceMemberId: member.id,
        conversationId: conversation.id as string,
        unreadCount: 0,
      })
    }

    for (const actor of actorRows) {
      await deps.ensureConversationParticipant({
        conversationId: conversation.id as string,
        participantType: CONVERSATION_PARTICIPANT_TYPE.ACTOR,
        actorId: actor.id,
        displayName: actor.displayName ?? undefined,
        queryable,
      })
    }

    for (const remoteAgent of remoteAgentRows) {
      await deps.ensureConversationParticipant({
        conversationId: conversation.id as string,
        participantType: CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT,
        remoteAgentId: remoteAgent.id,
        displayName: remoteAgent.displayName ?? undefined,
        queryable,
      })
    }

    if (workspaceMemberIds.length > 0) {
      await deps.syncConversationUpsert(
        queryable,
        params.workspaceId,
        workspaceMemberIds,
        conversation.id as string
      )
    }

    return conversation
  }

  if (params.queryable) {
    return executeCreate(params.queryable)
  }
  return withChatTransaction((client) => executeCreate(client))
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
