import {
  CONVERSATION_PARTICIPANT_TYPE,
  type ActorRuntimeTurnActivityDetail,
  type ChatConversationItem,
  type ChatDeviceState,
  type RemoteAgentRuntimeState,
  type ChatSyncEvent,
  type ChatSyncEventPayloadMap,
  type ChatSyncEventType,
} from "@synapse/shared"
import type {
  ConversationFeedEventPayloadMap,
  TaskSummary,
} from "@synapse/shared/types"
import type { Executor } from "../../infrastructure/database/kysely.js"
import { ensureClientInstance } from "./client-instances.js"
import { requireConversationAccess } from "./conversation-access.js"
import { buildChatConversationItems } from "./conversation-item-read.js"
import {
  loadChatConversationView,
  loadChatConversationViews,
} from "./conversation-view-read.js"
import { createChatError } from "./errors.js"
import {
  getConversationDeviceState,
  getConversationParticipantReadState,
  getWorkspaceMemberSyncCursor,
  listVisibleConversationMessageRows,
  listWorkspaceMemberSyncEventRows,
  chatRootExecutor,
  withChatRepeatableRead,
  type ChatConversationItemRow,
} from "./repo.js"
import {
  presentChatConversationRecord,
  presentInstant,
  presentOptionalInstant,
  type ChatBootstrapRecord,
  type ChatConversationEnvelopeRecord,
  type ChatConversationListRecord,
  type ChatConversationMessagesRecord,
  type ChatSyncRecord,
} from "./presenter.js"
import { getWorkspaceMemberIdentityOrThrow } from "./identity.js"
import {
  getConversationRuntimeMap,
  getSessionRuntimeTurnActivityDetail,
} from "../session/runtime.js"

type ItemRow = ChatConversationItemRow

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return 0
}

function rootQueryable(): Executor {
  return chatRootExecutor()
}

function asChatSyncEventPayload<T extends ChatSyncEventType>(
  eventType: T,
  payload: Record<string, unknown>
): ChatSyncEventPayloadMap[T] {
  return payload as unknown as ChatSyncEventPayloadMap[T]
}

async function enrichTaskSummaryForUser(task: TaskSummary, userId: string) {
  const { enrichTaskForUser } = await import("../tasks/service.js")
  return enrichTaskForUser(task, userId)
}

async function enrichChatConversationItemForViewer(
  item: ChatConversationItem,
  userId: string
): Promise<ChatConversationItem> {
  if (item.itemType !== "event" || item.subtype !== "task_requested") {
    return item
  }

  const payload = item.eventPayload
  const task =
    payload && typeof payload === "object" && "task" in payload
      ? (payload as ConversationFeedEventPayloadMap["task_requested"]).task
      : undefined

  if (!task) {
    return item
  }

  return {
    ...item,
    eventPayload: {
      ...payload,
      task: await enrichTaskSummaryForUser(task as TaskSummary, userId),
    },
  } as ChatConversationItem
}

async function enrichChatConversationItemsForViewer(
  items: ChatConversationItem[],
  userId: string
) {
  return Promise.all(
    items.map((item) => enrichChatConversationItemForViewer(item, userId))
  )
}

async function enrichChatSyncEventPayloadForViewer<T extends ChatSyncEventType>(
  eventType: T,
  payload: ChatSyncEventPayloadMap[T],
  userId: string
): Promise<ChatSyncEventPayloadMap[T]> {
  if (eventType === "conversation.item.created") {
    const eventPayload =
      payload as ChatSyncEventPayloadMap["conversation.item.created"]
    return {
      ...eventPayload,
      item: await enrichChatConversationItemForViewer(
        eventPayload.item,
        userId
      ),
    } as ChatSyncEventPayloadMap[T]
  }

  if (eventType === "task.updated") {
    const eventPayload = payload as ChatSyncEventPayloadMap["task.updated"]
    return {
      ...eventPayload,
      task: await enrichTaskSummaryForUser(eventPayload.task, userId),
    } as ChatSyncEventPayloadMap[T]
  }

  return payload
}

async function getCurrentSyncCursor(
  queryable: Executor,
  workspaceId: string,
  workspaceMemberId: string
) {
  // member_seq is the authoritative client cursor used by getChatSync.
  return toNumber(
    await getWorkspaceMemberSyncCursor(queryable, {
      workspaceId,
      workspaceMemberId,
    })
  )
}

export async function listWorkspaceConversationViews(params: {
  workspaceId: string
  workspaceMemberId: string
  queryable?: Executor
}) {
  const conversations = await loadChatConversationViews(
    params.queryable ?? rootQueryable(),
    params.workspaceId,
    params.workspaceMemberId
  )
  return conversations.map(presentChatConversationRecord)
}

export async function getChatBootstrap(params: {
  workspaceId: string
  userId: string
}): Promise<ChatBootstrapRecord> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  const { conversations, nextInboxCursor } = await withChatRepeatableRead(
    async (trx) => {
      const conversations = await loadChatConversationViews(
        trx,
        params.workspaceId,
        identity.workspaceMemberId
      )
      const nextInboxCursor = await getCurrentSyncCursor(
        trx,
        params.workspaceId,
        identity.workspaceMemberId
      )
      return { conversations, nextInboxCursor }
    }
  )

  return {
    workspaceMemberId: identity.workspaceMemberId,
    clientInstanceRequired: true,
    conversations,
    nextInboxCursor,
  }
}

export async function getChatSync(params: {
  workspaceId: string
  userId: string
  cursor?: number
  limit?: number
}): Promise<ChatSyncRecord> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  const limit = Math.min(Math.max(params.limit ?? 200, 1), 500)
  const result = await listWorkspaceMemberSyncEventRows(rootQueryable(), {
    workspaceId: params.workspaceId,
    workspaceMemberId: identity.workspaceMemberId,
    cursor: params.cursor ?? 0,
    limit: limit + 1,
  })

  const hasMore = result.length > limit
  const rows = hasMore ? result.slice(0, limit) : result
  const events: ChatSyncEvent[] = await Promise.all(
    rows.map(async (row) => {
      const eventType = row.eventType
      const payload = asChatSyncEventPayload(eventType, row.payload)
      const enrichedPayload = await enrichChatSyncEventPayloadForViewer(
        eventType,
        payload,
        identity.userId
      )
      return {
        syncSeq: toNumber(row.syncSeq),
        memberSeq: toNumber(row.memberSeq),
        workspaceId: row.workspaceId,
        workspaceMemberId: row.workspaceMemberId,
        conversationId: row.conversationId ?? undefined,
        itemId: row.itemId ?? undefined,
        eventType,
        payload: enrichedPayload,
        occurredAt: presentInstant(row.occurredAt),
      }
    })
  )

  return {
    events,
    nextCursor:
      events.length > 0
        ? events[events.length - 1]!.memberSeq
        : (params.cursor ?? 0),
    hasMore,
  }
}

export async function getChatConversationMessages(params: {
  workspaceId: string
  userId: string
  conversationId: string
  afterSequence?: number
  beforeSequence?: number
  limit?: number
  clientInstanceId: string
}): Promise<ChatConversationMessagesRecord> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  const access = await requireConversationAccess(
    rootQueryable(),
    params.conversationId,
    identity.workspaceMemberId
  )

  await ensureClientInstance(rootQueryable(), {
    workspaceId: params.workspaceId,
    workspaceMemberId: identity.workspaceMemberId,
    clientInstanceId: params.clientInstanceId,
  })

  const limit = Math.min(Math.max(params.limit ?? 100, 1), 200)
  let rows: ItemRow[] = []
  let hasMoreBefore = false
  let hasMoreAfter = false
  if (typeof params.afterSequence === "number") {
    const result = await listVisibleConversationMessageRows(rootQueryable(), {
      conversationId: params.conversationId,
      participantId: access.participant.id,
      afterSequence: params.afterSequence,
      limit: limit + 1,
    })
    hasMoreAfter = result.length > limit
    hasMoreBefore = params.afterSequence > 0
    rows = hasMoreAfter ? result.slice(0, limit) : result
  } else if (typeof params.beforeSequence === "number") {
    const result = await listVisibleConversationMessageRows(rootQueryable(), {
      conversationId: params.conversationId,
      participantId: access.participant.id,
      beforeSequence: params.beforeSequence,
      limit: limit + 1,
    })
    hasMoreBefore = result.length > limit
    hasMoreAfter = true
    rows = (hasMoreBefore ? result.slice(0, limit) : result).reverse()
  } else {
    const result = await listVisibleConversationMessageRows(rootQueryable(), {
      conversationId: params.conversationId,
      participantId: access.participant.id,
      limit: limit + 1,
    })
    hasMoreBefore = result.length > limit
    rows = (hasMoreBefore ? result.slice(0, limit) : result).reverse()
  }

  const items = await buildChatConversationItems(rootQueryable(), rows, {
    includeTransportDeliveries: true,
  })
  const enrichedItems = await enrichChatConversationItemsForViewer(
    items,
    identity.userId
  )

  const conversation = await loadChatConversationView(
    rootQueryable(),
    params.workspaceId,
    identity.workspaceMemberId,
    params.conversationId
  )
  if (!conversation) {
    throw createChatError(
      404,
      "conversation_not_found",
      "Conversation not found"
    )
  }

  const readState = await getConversationParticipantReadState(rootQueryable(), {
    conversationId: params.conversationId,
    participantId: access.participant.id,
  })

  const row = await getConversationDeviceState(rootQueryable(), {
    conversationId: params.conversationId,
    clientInstanceId: params.clientInstanceId,
  })
  const deviceState: ChatDeviceState = row
    ? {
        clientInstanceId: row.clientInstanceId,
        conversationId: row.conversationId,
        lastVisibleSequence: toNumber(row.lastVisibleSequence),
        lastInboxSeq: toNumber(row.lastInboxSeq),
        lastOpenedAt: presentOptionalInstant(row.lastOpenedAt),
        draftPayload: row.draftPayload,
      }
    : {
        clientInstanceId: params.clientInstanceId,
        conversationId: params.conversationId,
        lastVisibleSequence: 0,
        lastInboxSeq: 0,
        draftPayload: {},
      }

  const runtimeMap = await getConversationRuntimeMap([params.conversationId])
  const remoteAgentIds = conversation.participants
    .filter(
      (participant) =>
        participant.participantType ===
        CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT
    )
    .map((participant) => participant.remoteAgentId)
    .filter((value): value is string => Boolean(value))
  const runtimeByRemoteAgent: Record<string, RemoteAgentRuntimeState> = {}
  if (remoteAgentIds.length > 0) {
    const { loadRemoteAgentRuntimeSnapshot } =
      await import("../remote-agents/service.js")
    for (const remoteAgentId of remoteAgentIds) {
      const snapshot = await loadRemoteAgentRuntimeSnapshot(remoteAgentId, {
        conversationId: params.conversationId,
      })
      if (snapshot) {
        runtimeByRemoteAgent[remoteAgentId] = snapshot
      }
    }
  }

  return {
    conversation,
    items: enrichedItems,
    runtimeByActor: runtimeMap[params.conversationId] || {},
    runtimeByRemoteAgent,
    participantReadWatermarkSequence: toNumber(
      readState?.readWatermarkSequence
    ),
    deviceState,
    hasMoreBefore,
    hasMoreAfter,
  }
}

export async function getChatConversationActorRuntimeTurnDetail(params: {
  workspaceId: string
  userId: string
  conversationId: string
  actorId: string
  turnId: string
}): Promise<ActorRuntimeTurnActivityDetail> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  await requireConversationAccess(
    rootQueryable(),
    params.conversationId,
    identity.workspaceMemberId
  )

  const detail = await getSessionRuntimeTurnActivityDetail({
    conversationId: params.conversationId,
    actorId: params.actorId,
    turnId: params.turnId,
  })
  if (!detail) {
    throw createChatError(
      404,
      "runtime_turn_not_found",
      "Current turn activity not found"
    )
  }

  return detail
}

export async function listChatConversations(params: {
  workspaceId: string
  userId: string
}): Promise<ChatConversationListRecord> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  const conversations = await loadChatConversationViews(
    rootQueryable(),
    params.workspaceId,
    identity.workspaceMemberId
  )
  return {
    workspaceMemberId: identity.workspaceMemberId,
    conversations,
  }
}

export async function getChatConversationDetail(params: {
  workspaceId: string
  userId: string
  conversationId: string
}): Promise<ChatConversationEnvelopeRecord> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  const queryable = rootQueryable()
  await requireConversationAccess(
    queryable,
    params.conversationId,
    identity.workspaceMemberId
  )
  const conversation = await loadChatConversationView(
    queryable,
    params.workspaceId,
    identity.workspaceMemberId,
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
}
