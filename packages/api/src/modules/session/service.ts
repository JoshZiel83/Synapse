import {
  db,
  runBuilder,
  takeFirstOn,
  type Executor,
} from "../../infrastructure/database/kysely.js"
import { createLogger } from "../../infrastructure/logger/index.js"
import { queueConversationTransportProjection } from "../im/service.js"
import {
  createConversationItem,
  ensureConversationParticipant,
} from "../chat/service.js"
import {
  buildNormalizedMessageContent,
  itemPartsToCanonicalContentBlocks,
} from "../chat/message-content.js"
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
  isThreadConversationKind,
  nowISO,
} from "@synapse/shared"
import { sql } from "kysely"
import { SUBJECT_KIND } from "@synapse/shared"
import { parseSessionCollaborationState } from "./collaboration-state.js"
import {
  upsertAccessSubject,
  upsertAccessSubjectOn,
} from "../access/subject-registry.js"

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

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("collaboration_state must be a JSON object")
      }
      return parsed as Record<string, unknown>
    } catch (error) {
      throw new Error(
        `collaboration_state must be valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("collaboration_state must be an object")
  }
  return value as Record<string, unknown>
}

function normalizeSessionRow(row: any) {
  if (!row) return null
  return {
    ...row,
    conversationId: row.conversation_id,
    conversationKind: row.conversation_kind,
    isImConversation: Boolean(row.conversation_is_im),
    conversationTitle: row.conversation_title,
    collaborationMode: row.collaboration_mode || "default",
    activePlanApprovalTaskId: row.active_plan_approval_task_id || undefined,
    collaborationState: parseSessionCollaborationState(
      parseJsonObject(row.collaboration_state)
    ),
    isGroupConversation: isGroupConversationKind(row.conversation_kind),
    hasThreadContext: isThreadConversationKind(row.conversation_kind),
  }
}

async function getActorJoinVersionId(actorId: UUID) {
  const row = await db
    .selectFrom("actors as a")
    .innerJoin("actor_versions as current_version", (join) =>
      join
        .onRef("current_version.actor_id", "=", "a.id")
        .onRef("current_version.version", "=", "a.current_version")
    )
    .select("current_version.id as actor_version_id")
    .where("a.id", "=", actorId)
    .limit(1)
    .executeTakeFirst()
  return row?.actor_version_id || undefined
}

async function loadSession(sessionId: UUID): Promise<any | null> {
  const row = await db
    .selectFrom("sessions as s")
    .innerJoin("actors as a", "a.id", "s.actor_id")
    .innerJoin("conversations as c", "c.id", "s.conversation_id")
    .selectAll("s")
    .select((eb) => [
      "a.name as actor_name",
      "c.kind as conversation_kind",
      eb
        .exists(
          eb
            .selectFrom("conversation_transport_bindings as b")
            .select("b.id")
            .whereRef("b.conversation_id", "=", "c.id")
        )
        .as("conversation_is_im"),
      "c.title as conversation_title",
    ])
    .where("s.id", "=", sessionId)
    .executeTakeFirst()
  return normalizeSessionRow(row ?? null)
}

async function getConversationActorSessionRow(
  conversationId: UUID,
  actorId: UUID,
  queryable: Executor = db
) {
  return takeFirstOn(
    queryable,
    db
      .selectFrom("sessions")
      .selectAll()
      .where("conversation_id", "=", conversationId)
      .where("actor_id", "=", actorId)
      .limit(1)
  )
}

async function requireActiveActorConversationParticipant(
  conversationId: UUID,
  actorId: UUID,
  queryable: Executor = db
) {
  // P1b: upsert the actor's subject_id (on the same queryable for trx safety),
  // then filter conversation_participants by subject_id.
  const actorSubjectId = await upsertAccessSubjectOn(queryable, {
    kind: SUBJECT_KIND.ACTOR,
    actorId,
  })
  const participant = await takeFirstOn(
    queryable,
    db
      .selectFrom("conversation_participants")
      .select("id")
      .where("conversation_id", "=", conversationId)
      .where("subject_id", "=", actorSubjectId)
      .where("state", "=", "active")
      .limit(1)
  )

  if (!participant) {
    throw new Error(
      `Actor ${actorId} is not an active participant of conversation ${conversationId}`
    )
  }
}

export async function ensureConversationActorSessionContext(
  params: {
    workspaceId?: UUID
    actorId: UUID
    conversationId: UUID
    trigger?: SessionTrigger
  },
  queryable: Executor = db
) {
  await requireActiveActorConversationParticipant(
    params.conversationId,
    params.actorId,
    queryable
  )

  let session = await getConversationActorSessionRow(
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

    const insertedSession = await takeFirstOn<{ id: string }>(
      queryable,
      db
        .insertInto("sessions")
        .values({
          id: uuidv4(),
          workspace_id: params.workspaceId,
          actor_id: params.actorId,
          conversation_id: params.conversationId,
          trigger: params.trigger || "user_message",
          status: "idle",
        })
        .onConflict((oc) =>
          oc.columns(["conversation_id", "actor_id"]).doNothing()
        )
        .returning("id")
    )
    sessionCreated = Boolean(insertedSession)
    session = await getConversationActorSessionRow(
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
    const actorJoinVersionId = await getActorJoinVersionId(params.fromActorId)
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

function buildMetadataFromItem(item: any) {
  return typeof item.metadata === "string"
    ? JSON.parse(item.metadata)
    : { ...(item.metadata || {}) }
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
  await db
    .updateTable("sessions")
    .set({
      status,
      updated_at: sql`NOW()`,
      completed_at: status === "closed" ? sql`NOW()` : null,
      ...(extra?.errorMessage !== undefined
        ? { error_message: extra.errorMessage }
        : {}),
    })
    .where("id", "=", sessionId)
    .execute()
}

export async function updateSessionCollaboration(
  params: {
    sessionId: UUID
    collaborationMode?: SessionCollaborationMode
    collaborationState?: SessionCollaborationState
    activePlanApprovalTaskId?: UUID | null
  },
  queryable: Executor = db
): Promise<void> {
  const values: Record<string, unknown> = {
    updated_at: sql`NOW()`,
  }

  if (params.collaborationMode) {
    values.collaboration_mode = params.collaborationMode
  }
  if (params.collaborationState) {
    values.collaboration_state = parseSessionCollaborationState(
      params.collaborationState
    ) as Record<string, unknown>
  }
  if ("activePlanApprovalTaskId" in params) {
    values.active_plan_approval_task_id =
      params.activePlanApprovalTaskId ?? null
  }

  await runBuilder(
    queryable,
    db.updateTable("sessions").set(values).where("id", "=", params.sessionId)
  )
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
    conversationId: session.conversation_id,
    workspaceId,
    fromActorId,
    fromWorkspaceMemberId,
  })
  const { scope, surface } =
    visibility === "shared_visible"
      ? { scope: "shared" as const, surface: "visible" as const }
      : getSurfaceForSessionMessage(session.conversation_kind, role)
  const itemType = role === "tool_result" ? "control" : "message"
  const resolvedSubtype = subtype || role

  const item = await createConversationItem({
    workspaceId,
    conversationId: session.conversation_id,
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
      conversationId: session.conversation_id,
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
    await notifyRemoteAgentDeliveriesForConversation(session.conversation_id)
  }

  if (
    scope === "shared" &&
    surface === "visible" &&
    !isGroupConversationKind(session.conversation_kind) &&
    (role === "user" || role === "assistant")
  ) {
    let actorName: string | undefined
    if (fromActorId) {
      actorName = (
        await db
          .selectFrom("actors")
          .select("name")
          .where("id", "=", fromActorId)
          .executeTakeFirst()
      )?.name
    }
    // session.message.new event emit removed (S13): no subscribers remain.
    void normalizedMessage
    void item
    void actorName
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
  const items = await db
    .selectFrom("conversation_items as ci")
    .innerJoin("sessions as s", "s.id", "ci.session_id")
    .leftJoin(
      "conversation_participants as cp",
      "cp.id",
      "ci.author_participant_id"
    )
    .leftJoin("access_subjects as cpsubj", "cpsubj.id", "cp.subject_id")
    .leftJoin("actors as a", "a.id", "cpsubj.actor_id")
    .leftJoin("workspace_members as wm", "wm.id", "cpsubj.workspace_member_id")
    .leftJoin("users as u", "u.id", "wm.user_id")
    .select([
      "ci.id",
      "ci.session_id",
      "ci.conversation_id",
      "ci.sequence",
      "ci.role",
      "ci.subtype",
      "ci.metadata",
      "ci.event_payload",
      "ci.author_participant_id",
      "ci.created_at",
      "s.workspace_id",
      "cpsubj.actor_id as from_actor_id",
      "cpsubj.workspace_member_id as from_workspace_member_id",
      sql<string | null>`COALESCE(a.name, u.name, cp.display_name)`.as(
        "author_name"
      ),
    ])
    .where("ci.session_id", "=", sessionId)
    .orderBy("ci.created_at", "asc")
    .orderBy("ci.sequence", "asc")
    .execute()

  if (items.length === 0) return []

  const itemIds = items.map((row) => row.id)
  const partRows = await db
    .selectFrom("conversation_item_parts as cip")
    .select([
      "cip.id",
      "cip.item_id",
      "cip.ordinal",
      "cip.part_type",
      "cip.mime_type",
      "cip.text_value",
      "cip.json_value",
      "cip.ref_path",
      "cip.ref_sha256",
      "cip.name",
      "cip.metadata",
    ])
    .where("cip.item_id", "in", itemIds)
    .orderBy("cip.item_id", "asc")
    .orderBy("cip.ordinal", "asc")
    .execute()

  const partsByItem = new Map<string, any[]>()
  for (const row of partRows) {
    if (!partsByItem.has(row.item_id)) partsByItem.set(row.item_id, [])
    partsByItem.get(row.item_id)!.push(row)
  }

  return items.map((row: any) => {
    const item = { ...row, parts: partsByItem.get(row.id) || [] }
    return {
      id: row.id,
      sessionId: row.session_id,
      conversationId: row.conversation_id,
      sequence: row.sequence,
      workspaceId: row.workspace_id,
      role: row.subtype || row.role,
      contentBlocks: itemPartsToCanonicalContentBlocks(item.parts || []),
      fromActorId: row.from_actor_id || undefined,
      fromWorkspaceMemberId: row.from_workspace_member_id || undefined,
      metadata: buildMetadataFromItem(item),
      createdAt: row.created_at,
    }
  })
}

// ============ Session Interrupts ============

export async function consumeInterrupts(sessionId: UUID): Promise<any[]> {
  return db
    .updateTable("session_interrupts")
    .set({
      is_consumed: true,
    })
    .where("target_session_id", "=", sessionId)
    .where("is_consumed", "=", false)
    .returningAll()
    .execute()
}

export async function hasPendingInterrupt(
  sessionId: UUID,
  type?: SessionInterruptType
): Promise<boolean> {
  let query = db
    .selectFrom("session_interrupts")
    .select("id")
    .where("target_session_id", "=", sessionId)
    .where("is_consumed", "=", false)

  if (type) {
    query = query.where("type", "=", type)
  }

  const row = await query.limit(1).executeTakeFirst()
  return Boolean(row?.id)
}
