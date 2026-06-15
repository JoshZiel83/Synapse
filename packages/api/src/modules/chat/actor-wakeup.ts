import {
  CONVERSATION_ITEM_SCOPE,
  CONVERSATION_ITEM_SURFACE,
  CONVERSATION_ITEM_TYPE,
  CONVERSATION_KINDS,
  CONVERSATION_PARTICIPANT_STATE,
  CONVERSATION_PARTICIPANT_TYPE,
  type SessionWakeupSourceParticipantType,
} from "@synapse/shared"
import type { Executor } from "../../infrastructure/database/kysely.js"
import { hydrateConversationItems } from "./conversation-item-read.js"
import {
  chatRootExecutor,
  conversationItemHasTargets,
  getConversationKind,
  listChatConversationParticipantRows,
  listConversationItemRowsByIds,
  listMentionedParticipantIdsForConversationItem,
  type ChatConversationItemRow,
  type ChatParticipantRow,
} from "./repo.js"

type ConversationKind = (typeof CONVERSATION_KINDS)[number]

export type PendingActorWakeup = {
  actorId: string
  sessionId: string
  sourceType: "user_message" | "actor_message"
}

export type EnqueueActorWakeupsInput = {
  workspaceId: string
  conversationId: string
  itemId: string
  sourceParticipantType?: SessionWakeupSourceParticipantType
  sourceParticipantId?: string
  sourceName?: string
  summary?: string
  queryable: Executor
}

export type ActorWakeupDeps = {
  listItemRowsByIds: (
    queryable: Executor,
    itemIds: string[]
  ) => Promise<ChatConversationItemRow[]>
  conversationItemHasTargets: (
    queryable: Executor,
    itemId: string
  ) => Promise<boolean>
  getConversationKind: (
    queryable: Executor,
    conversationId: string
  ) => Promise<ConversationKind | null>
  listConversationParticipants: (
    queryable: Executor,
    conversationIds: string[],
    options?: { useProfileSnapshot?: boolean }
  ) => Promise<ChatParticipantRow[]>
  listMentionedParticipantIdsForItem: (
    queryable: Executor,
    itemId: string
  ) => Promise<string[]>
  hydrateConversationItems: (
    queryable: Executor,
    itemRows: ChatConversationItemRow[]
  ) => Promise<Array<{ content: string }>>
  ensureConversationActorSessionContext: (
    params: {
      workspaceId: string
      actorId: string
      conversationId: string
      trigger: PendingActorWakeup["sourceType"]
    },
    queryable: Executor
  ) => Promise<{ sessionId: string }>
  enqueueSessionWakeup: (params: {
    sessionId: string
    actorId: string
    workspaceId: string
    sourceType: PendingActorWakeup["sourceType"]
    sourceItemId: string
    sourceParticipantType: SessionWakeupSourceParticipantType
    sourceParticipantId?: string
    sourceName?: string
    summary: string
    metadata: Record<string, unknown>
    trigger: PendingActorWakeup["sourceType"]
  }) => Promise<void>
}

function rootQueryable(): Executor {
  return chatRootExecutor()
}

async function listItemRowsByIds(queryable: Executor, itemIds: string[]) {
  return listConversationItemRowsByIds(queryable, itemIds)
}

async function listConversationParticipantRows(
  queryable: Executor,
  conversationIds: string[],
  options?: { useProfileSnapshot?: boolean }
) {
  return listChatConversationParticipantRows(
    queryable,
    conversationIds,
    options
  )
}

async function listMentionedParticipantIdsForItem(
  queryable: Executor,
  itemId: string
) {
  return listMentionedParticipantIdsForConversationItem(queryable, itemId)
}

function chatActorWakeupDeps(): ActorWakeupDeps {
  return {
    listItemRowsByIds,
    conversationItemHasTargets,
    getConversationKind,
    listConversationParticipants: listConversationParticipantRows,
    listMentionedParticipantIdsForItem,
    hydrateConversationItems,
    ensureConversationActorSessionContext: async (params, queryable) => {
      const { ensureConversationActorSessionContext } =
        await import("../session/service.js")
      return ensureConversationActorSessionContext(params, queryable)
    },
    enqueueSessionWakeup: async (params) => {
      const { enqueueSessionWakeup } = await import("../session/runtime.js")
      await enqueueSessionWakeup(params)
    },
  }
}

function participantDisplayName(row: ChatParticipantRow): string {
  if (row.participantType === CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER) {
    if (typeof row.userName === "string" && row.userName.trim()) {
      return row.userName.trim()
    }
  }
  if (row.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR) {
    if (typeof row.participantName === "string" && row.participantName.trim()) {
      return row.participantName.trim()
    }
  }
  if (row.participantType === CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT) {
    if (typeof row.participantName === "string" && row.participantName.trim()) {
      return row.participantName.trim()
    }
  }
  if (
    row.participantType === CONVERSATION_PARTICIPANT_TYPE.EXTERNAL &&
    typeof row.transportDisplayName === "string" &&
    row.transportDisplayName.trim()
  ) {
    return row.transportDisplayName.trim()
  }
  if (
    row.participantType === CONVERSATION_PARTICIPANT_TYPE.EXTERNAL &&
    typeof row.displayName === "string" &&
    row.displayName.trim()
  ) {
    return row.displayName.trim()
  }
  if (typeof row.linkedUserName === "string" && row.linkedUserName.trim()) {
    return row.linkedUserName.trim()
  }
  if (typeof row.userName === "string" && row.userName.trim()) {
    return row.userName.trim()
  }
  if (typeof row.participantName === "string" && row.participantName.trim()) {
    return row.participantName.trim()
  }
  if (typeof row.displayName === "string" && row.displayName.trim()) {
    return row.displayName.trim()
  }
  return "Unknown"
}

export function resolveActorWakeParticipants(params: {
  conversationKind: ConversationKind
  activeParticipants: ChatParticipantRow[]
  authorParticipantId?: string
  mentionedParticipantIds: string[]
  replyAuthorParticipantId?: string | null
}) {
  const actorParticipants = params.activeParticipants.filter(
    (participant) =>
      participant.id !== params.authorParticipantId &&
      participant.state === CONVERSATION_PARTICIPANT_STATE.ACTIVE &&
      typeof participant.actorId === "string" &&
      participant.actorId.length > 0
  )
  if (actorParticipants.length === 0) {
    return []
  }
  if (params.conversationKind !== "group") {
    return actorParticipants
  }

  const mentionedSet = new Set(params.mentionedParticipantIds)
  const explicitWakeTargets = new Map<string, ChatParticipantRow>()
  for (const participant of actorParticipants) {
    if (mentionedSet.has(participant.id)) {
      explicitWakeTargets.set(participant.id, participant)
    }
  }
  if (params.replyAuthorParticipantId) {
    const replyActor = actorParticipants.find(
      (participant) => participant.id === params.replyAuthorParticipantId
    )
    if (replyActor) {
      explicitWakeTargets.set(replyActor.id, replyActor)
    }
  }
  if (explicitWakeTargets.size > 0) {
    return Array.from(explicitWakeTargets.values())
  }
  if (params.mentionedParticipantIds.length > 0) {
    return []
  }
  return actorParticipants
}

function normalizeWakeSummary(summary: string) {
  return summary.replace(/\s+/g, " ").trim().slice(0, 96) || "New message"
}

export async function enqueueActorWakeupsForConversationMessageUseCase(
  params: EnqueueActorWakeupsInput,
  deps: ActorWakeupDeps
): Promise<PendingActorWakeup[]> {
  const queryable = params.queryable
  const itemRows = await deps.listItemRowsByIds(queryable, [params.itemId])
  const itemRow = itemRows[0]
  if (!itemRow) {
    return []
  }
  if (
    itemRow.itemType !== CONVERSATION_ITEM_TYPE.MESSAGE ||
    itemRow.scope !== CONVERSATION_ITEM_SCOPE.SHARED ||
    itemRow.surface !== CONVERSATION_ITEM_SURFACE.VISIBLE
  ) {
    return []
  }

  if (await deps.conversationItemHasTargets(queryable, params.itemId)) {
    return []
  }

  const conversationKind = await deps.getConversationKind(
    queryable,
    params.conversationId
  )
  if (!conversationKind) {
    return []
  }

  const activeParticipants = await deps
    .listConversationParticipants(queryable, [params.conversationId], {
      useProfileSnapshot: true,
    })
    .then((participants) =>
      participants.filter(
        (participant) =>
          participant.state === CONVERSATION_PARTICIPANT_STATE.ACTIVE
      )
    )
  const authorParticipant = itemRow.authorParticipantId
    ? activeParticipants.find(
        (participant) => participant.id === itemRow.authorParticipantId
      )
    : undefined
  const sourceParticipantType =
    params.sourceParticipantType ?? authorParticipant?.participantType
  if (!sourceParticipantType || sourceParticipantType === "system") {
    return []
  }

  const mentionedParticipantIds = await deps.listMentionedParticipantIdsForItem(
    queryable,
    params.itemId
  )
  const replyAuthorParticipantId = itemRow.replyToItemId
    ? ((await deps.listItemRowsByIds(queryable, [itemRow.replyToItemId]))[0]
        ?.authorParticipantId ?? null)
    : null
  const wakeParticipants = resolveActorWakeParticipants({
    conversationKind,
    activeParticipants,
    authorParticipantId: itemRow.authorParticipantId ?? undefined,
    mentionedParticipantIds,
    replyAuthorParticipantId,
  })
  if (wakeParticipants.length === 0) {
    return []
  }

  const sourceType =
    sourceParticipantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR
      ? "actor_message"
      : "user_message"
  const sourceParticipantId =
    params.sourceParticipantId ??
    (sourceParticipantType === CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER
      ? (authorParticipant?.workspaceMemberId ?? undefined)
      : sourceParticipantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR
        ? (authorParticipant?.actorId ?? undefined)
        : (itemRow.authorParticipantId ?? undefined))
  const sourceName =
    params.sourceName ??
    (authorParticipant ? participantDisplayName(authorParticipant) : undefined)
  const itemSummary =
    params.summary ??
    (await deps.hydrateConversationItems(queryable, [itemRow]))
      .map((item) => item.content.trim())
      .find(Boolean) ??
    "New message"

  const pendingWakeups: PendingActorWakeup[] = []
  for (const participant of wakeParticipants) {
    if (!participant.actorId) {
      continue
    }
    const ensuredContext = await deps.ensureConversationActorSessionContext(
      {
        workspaceId: params.workspaceId,
        actorId: participant.actorId,
        conversationId: params.conversationId,
        trigger: sourceType,
      },
      queryable
    )
    await deps.enqueueSessionWakeup({
      sessionId: ensuredContext.sessionId,
      actorId: participant.actorId,
      workspaceId: params.workspaceId,
      sourceType,
      sourceItemId: params.itemId,
      sourceParticipantType,
      sourceParticipantId,
      sourceName,
      summary: normalizeWakeSummary(itemSummary),
      metadata: {
        source: "chat.message_wakeup",
        conversationId: params.conversationId,
      },
      trigger: sourceType,
    })
    pendingWakeups.push({
      actorId: participant.actorId,
      sessionId: ensuredContext.sessionId,
      sourceType,
    })
  }

  return pendingWakeups
}

export async function enqueueActorWakeupsForConversationMessage(params: {
  workspaceId?: string
  conversationId: string
  itemId: string
  // sourceParticipantType mixes a real participant author kind with the
  // "system" wakeup source (automation / tool-call completion), so it is typed
  // as the wakeup-source enum (which retains 'system') rather than a DB
  // participant kind. The DB participant kind never equals 'system'.
  sourceParticipantType?: SessionWakeupSourceParticipantType
  sourceParticipantId?: string
  sourceName?: string
  summary?: string
  queryable?: Executor
}) {
  if (!params.workspaceId) {
    return []
  }
  return enqueueActorWakeupsForConversationMessageUseCase(
    {
      ...params,
      workspaceId: params.workspaceId,
      queryable: params.queryable ?? rootQueryable(),
    },
    chatActorWakeupDeps()
  )
}
