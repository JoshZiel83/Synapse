import { type Executor } from "../../infrastructure/database/kysely.js"
import { createLogger } from "../../infrastructure/logger/index.js"
import { queueConversationTransportProjection } from "../im/service.js"
import {
  createConversationItem,
  ensureConversationParticipant,
} from "../chat/service.js"
import { buildNormalizedMessageContent } from "../chat/message-content.js"
import type {
  UUID,
  ConversationMessageSubtype,
  CanonicalContentBlock,
  SessionMessage,
} from "@synapse/shared"
import type {
  SessionCollaborationMode,
  SessionCollaborationState,
} from "@synapse/shared/types"
import {
  type SessionInterruptType,
  type SessionStatus,
  type SessionTrigger,
  isGroupConversationKind,
} from "@synapse/shared"
import { parseSessionCollaborationState } from "./collaboration-state.js"
import * as repo from "./repo.js"
import { presentSession, presentSessionMessage } from "./presenter.js"

type SessionConversationMessageRole =
  | "user"
  | "assistant"
  | "system"
  | "tool_result"

type SessionConversationMessageSubtype = Exclude<
  ConversationMessageSubtype,
  "chat.message"
>
import { v4 as uuidv4 } from "uuid"

const log = createLogger("session")

async function loadSession(sessionId: UUID) {
  const row = await repo.loadSessionRow(sessionId)
  return presentSession(row)
}

export async function ensureConversationActorSessionContext(
  params: {
    workspaceId?: UUID
    actorId: UUID
    conversationId: UUID
    trigger?: SessionTrigger
  },
  queryable?: Executor
) {
  await repo.requireActiveActorConversationParticipant(
    params.conversationId,
    params.actorId,
    queryable
  )

  let session = await repo.getConversationActorSessionRow(
    params.conversationId,
    params.actorId,
    queryable
  )
  let sessionCreated = false

  if (!session) {
    if (!params.workspaceId) {
      throw new Error(
        `workspaceId is required to create a session for actor ${params.actorId} in conversation ${params.conversationId}`
      )
    }

    const insertedSession = await repo.insertSessionIfAbsent(
      {
        id: uuidv4(),
        workspaceId: params.workspaceId,
        actorId: params.actorId,
        conversationId: params.conversationId,
        trigger: params.trigger,
      },
      queryable
    )
    sessionCreated = Boolean(insertedSession)
    session = await repo.getConversationActorSessionRow(
      params.conversationId,
      params.actorId,
      queryable
    )
  }

  if (!session) {
    throw new Error(
      `Failed to resolve session for actor ${params.actorId} in conversation ${params.conversationId}`
    )
  }

  return {
    sessionId: session.id,
    sessionCreated,
  }
}

async function resolveSessionMessageAuthor(params: {
  conversationId: string
  workspaceId?: UUID
  workspaceMemberId?: UUID
  fromActorId?: UUID
  fromWorkspaceMemberId?: UUID
}) {
  if (params.fromActorId) {
    const actorJoinVersionId = await repo.getActorJoinVersionId(
      params.fromActorId
    )
    return ensureConversationParticipant({
      conversationId: params.conversationId,
      participantType: "actor",
      actorId: params.fromActorId,
      actorJoinVersionId,
    })
  }

  if (params.fromWorkspaceMemberId) {
    return ensureConversationParticipant({
      conversationId: params.conversationId,
      participantType: "workspace_member",
      workspaceMemberId: params.fromWorkspaceMemberId,
    })
  }

  return null
}

function getSurfaceForSessionMessage(
  conversationKind: string,
  role: SessionConversationMessageRole | "child_result"
) {
  if (isGroupConversationKind(conversationKind)) {
    return { scope: "private" as const, surface: "internal" as const }
  }

  if (role === "tool_result" || role === "child_result") {
    return { scope: "private" as const, surface: "internal" as const }
  }

  return { scope: "shared" as const, surface: "visible" as const }
}

// ============ Session CRUD ============

export async function getSession(sessionId: UUID): Promise<any | null> {
  return loadSession(sessionId)
}

export async function updateSessionStatus(
  sessionId: UUID,
  status: SessionStatus,
  extra?: { errorMessage?: string | null }
): Promise<void> {
  await repo.updateSessionStatus(sessionId, status, extra)
}

export async function updateSessionCollaboration(
  params: {
    sessionId: UUID
    collaborationMode?: SessionCollaborationMode
    collaborationState?: SessionCollaborationState
    activePlanApprovalTaskId?: UUID | null
  },
  queryable?: Executor
): Promise<void> {
  const values: Record<string, unknown> = {}

  if (params.collaborationMode) {
    values.collaborationMode = params.collaborationMode
  }
  if (params.collaborationState) {
    values.collaborationState = parseSessionCollaborationState(
      params.collaborationState
    ) as Record<string, unknown>
  }
  if ("activePlanApprovalTaskId" in params) {
    values.activePlanApprovalTaskId = params.activePlanApprovalTaskId ?? null
  }

  await repo.setSessionCollaborationValues(params.sessionId, values, queryable)
}

// ============ Session Messages ============

export async function addSessionMessage(params: {
  sessionId: UUID
  workspaceId: UUID
  role: SessionConversationMessageRole
  contentBlocks: CanonicalContentBlock[]
  fromActorId?: UUID
  fromWorkspaceMemberId?: UUID
  subtype?: SessionConversationMessageSubtype
  visibility?: "default" | "shared_visible"
  metadata?: Record<string, unknown>
  replyToItemId?: UUID
  restrictedAudienceParticipantIds?: UUID[]
  projectTransportOutbound?: boolean
}): Promise<SessionMessage> {
  const {
    sessionId,
    workspaceId,
    role,
    contentBlocks,
    fromActorId,
    fromWorkspaceMemberId,
    subtype,
    visibility = "default",
    metadata = {},
    replyToItemId,
    restrictedAudienceParticipantIds,
    projectTransportOutbound = false,
  } = params
  const session = await getSession(sessionId)
  if (!session) throw new Error(`Session ${sessionId} not found`)
  if (!Array.isArray(contentBlocks) || contentBlocks.length === 0) {
    throw new Error("contentBlocks is required")
  }
  const normalizedMessage = await buildNormalizedMessageContent({
    content: "",
    contentBlocks,
    metadata,
  })

  const authorMember = await resolveSessionMessageAuthor({
    conversationId: session.conversationId,
    workspaceId,
    fromActorId,
    fromWorkspaceMemberId,
  })
  const { scope, surface } =
    visibility === "shared_visible"
      ? { scope: "shared" as const, surface: "visible" as const }
      : getSurfaceForSessionMessage(session.conversationKind, role)
  const itemType = role === "tool_result" ? "control" : "message"
  const resolvedSubtype = subtype || role

  const item = await createConversationItem({
    workspaceId,
    conversationId: session.conversationId,
    sessionId,
    scope,
    surface,
    itemType,
    subtype: resolvedSubtype,
    role:
      role === "tool_result"
        ? "tool"
        : role === "system"
          ? "system"
          : role === "assistant"
            ? "assistant"
            : "user",
    authorParticipantId: authorMember?.id,
    replyToItemId,
    metadata: normalizedMessage.normalizedMetadata,
    parts: normalizedMessage.parts,
    restrictedAudienceParticipantIds,
  })

  if (projectTransportOutbound && scope === "shared" && surface === "visible") {
    await queueConversationTransportProjection({
      workspaceId,
      conversationId: session.conversationId,
      itemId: item.id,
      direction: "outbound",
      metadata: {
        senderType: fromActorId
          ? "actor"
          : fromWorkspaceMemberId
            ? "workspace_member"
            : "system",
        senderActorId: fromActorId || undefined,
        senderWorkspaceMemberId: fromWorkspaceMemberId || undefined,
        restrictedAudienceParticipantIds,
      },
    }).catch((error) => {
      log.error(
        { err: error },
        `Failed to queue transport projection for session item ${item.id}`
      )
    })
  }

  if (scope === "shared" && surface === "visible") {
    const { notifyRemoteAgentDeliveriesForConversation } =
      await import("../remote-agents/service.js")
    await notifyRemoteAgentDeliveriesForConversation(session.conversationId)
  }

  if (
    scope === "shared" &&
    surface === "visible" &&
    !isGroupConversationKind(session.conversationKind) &&
    (role === "user" || role === "assistant")
  ) {
    let actorDisplayName: string | undefined
    if (fromActorId) {
      actorDisplayName = await repo.getActorDisplayName(fromActorId)
    }
    // session.message.new event emit removed (S13): no subscribers remain.
    void normalizedMessage
    void item
    void actorDisplayName
    void role
    void fromWorkspaceMemberId
  }

  return {
    id: item.id,
    sessionId,
    workspaceId,
    role,
    contentBlocks: normalizedMessage.contentBlocks,
    fromActorId: fromActorId || undefined,
    fromWorkspaceMemberId: fromWorkspaceMemberId || undefined,
    metadata: normalizedMessage.normalizedMetadata,
    createdAt: item.createdAt,
  }
}

export async function getSessionMessages(
  sessionId: UUID
): Promise<SessionMessage[]> {
  const items = await repo.getSessionMessageItemRows(sessionId)

  if (items.length === 0) return []

  const itemIds = items.map((row) => row.id)
  const partRows = await repo.getSessionMessagePartRows(itemIds)

  const partsByItem = new Map<string, (typeof partRows)[number][]>()
  for (const row of partRows) {
    if (!partsByItem.has(row.itemId)) partsByItem.set(row.itemId, [])
    partsByItem.get(row.itemId)!.push(row)
  }

  return items.map((row) =>
    presentSessionMessage(row, sessionId, partsByItem.get(row.id) || [])
  )
}

// ============ Session Interrupts ============

export async function consumeInterrupts(sessionId: UUID): Promise<any[]> {
  return repo.consumeSessionInterrupts(sessionId)
}

export async function hasPendingInterrupt(
  sessionId: UUID,
  type?: SessionInterruptType
): Promise<boolean> {
  return repo.hasPendingSessionInterrupt(sessionId, type)
}
