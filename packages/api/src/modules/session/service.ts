import {
  db,
  runBuilder,
  takeFirstOn,
  type Executor,
  type TableRow,
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

type SessionRow = TableRow<"sessions"> & {
  actorDisplayName?: string | null
  conversationKind?: string | null
  conversationIsIm?: unknown
  conversationTitle?: string | null
}

type SessionMessageItemRow = {
  id: string
  sessionId: string | null
  conversationId: string
  sequence: number | string
  workspaceId: string
  subtype: string
  role: TableRow<"conversationItems">["role"]
  fromActorId: string | null
  fromWorkspaceMemberId: string | null
  createdAt: Date
  metadata: unknown
}

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

function normalizeSessionRow(row: SessionRow | null) {
  if (!row) return null
  return {
    ...row,
    conversationId: row.conversationId,
    conversationKind: row.conversationKind,
    isImConversation: Boolean(row.conversationIsIm),
    conversationTitle: row.conversationTitle,
    collaborationMode: row.collaborationMode || "default",
    activePlanApprovalTaskId: row.activePlanApprovalTaskId || undefined,
    collaborationState: parseSessionCollaborationState(
      parseJsonObject(row.collaborationState)
    ),
    isGroupConversation: isGroupConversationKind(row.conversationKind),
    hasThreadContext: isThreadConversationKind(row.conversationKind),
  }
}

function normalizeSessionMessageRole(
  row: Pick<SessionMessageItemRow, "role" | "subtype">
): SessionMessage["role"] {
  if (row.subtype === "tool_result" || row.role === "tool") {
    return "tool_result"
  }
  return row.role
}

async function getActorJoinVersionId(actorId: UUID) {
  const row = await db
    .selectFrom("actors as a")
    .innerJoin("workspaceApps as app", "app.id", "a.id")
    .innerJoin("actorVersions as current_version", (join) =>
      join
        .onRef("current_version.actorId", "=", "a.id")
        .onRef("current_version.version", "=", "a.currentVersion")
    )
    .select("current_version.id as actorVersionId")
    .where("a.id", "=", actorId)
    .where("app.deletedAt", "is", null)
    .limit(1)
    .executeTakeFirst()
  return row?.actorVersionId || undefined
}

async function loadSession(
  sessionId: UUID
): Promise<ReturnType<typeof normalizeSessionRow>> {
  const row = await db
    .selectFrom("sessions as s")
    .innerJoin("actors as a", "a.id", "s.actorId")
    .innerJoin("workspaceApps as app", "app.id", "a.id")
    .innerJoin("conversations as c", "c.id", "s.conversationId")
    .selectAll("s")
    .select((eb) => [
      "app.displayName as actorDisplayName",
      "c.kind as conversationKind",
      eb
        .exists(
          eb
            .selectFrom("conversationTransportBindings as b")
            .select("b.id")
            .whereRef("b.conversationId", "=", "c.id")
        )
        .as("conversationIsIm"),
      "c.title as conversationTitle",
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
      .where("conversationId", "=", conversationId)
      .where("actorId", "=", actorId)
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
      .selectFrom("conversationParticipants")
      .select("id")
      .where("conversationId", "=", conversationId)
      .where("subjectId", "=", actorSubjectId)
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
          workspaceId: params.workspaceId,
          actorId: params.actorId,
          conversationId: params.conversationId,
          trigger: params.trigger || "user_message",
          status: "idle",
        })
        .onConflict((oc) =>
          oc.columns(["conversationId", "actorId"]).doNothing()
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
      completedAt: status === "closed" ? sql`NOW()` : null,
      ...(extra?.errorMessage !== undefined
        ? { errorMessage: extra.errorMessage }
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
      actorDisplayName = (
        await db
          .selectFrom("actors as actor")
          .innerJoin("workspaceApps as app", "app.id", "actor.id")
          .select("app.displayName as displayName")
          .where("actor.id", "=", fromActorId)
          .where("app.deletedAt", "is", null)
          .executeTakeFirst()
      )?.displayName
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
  const items = await db
    .selectFrom("conversationItems as ci")
    .innerJoin("sessions as s", "s.id", "ci.sessionId")
    .leftJoin(
      "conversationParticipants as cp",
      "cp.id",
      "ci.authorParticipantId"
    )
    .leftJoin("accessSubjects as cpsubj", "cpsubj.id", "cp.subjectId")
    .leftJoin("actors as a", "a.id", "cpsubj.actorId")
    .leftJoin("workspaceApps as actor_app", "actor_app.id", "a.id")
    .leftJoin("workspaceMembers as wm", "wm.id", "cpsubj.workspaceMemberId")
    .leftJoin("users as u", "u.id", "wm.userId")
    .select([
      "ci.id",
      "ci.sessionId",
      "ci.conversationId",
      "ci.sequence",
      "ci.role",
      "ci.subtype",
      "ci.metadata",
      "ci.eventPayload",
      "ci.authorParticipantId",
      "ci.createdAt",
      "s.workspaceId",
      "cpsubj.actorId as fromActorId",
      "cpsubj.workspaceMemberId as fromWorkspaceMemberId",
      sql<
        string | null
      >`COALESCE(actor_app.display_name, u.name, cp.display_name)`.as(
        "authorName"
      ),
    ])
    .where("ci.sessionId", "=", sessionId)
    .orderBy("ci.createdAt", "asc")
    .orderBy("ci.sequence", "asc")
    .execute()

  if (items.length === 0) return []

  const itemIds = items.map((row) => row.id)
  const partRows = await db
    .selectFrom("conversationItemParts as cip")
    .select([
      "cip.id",
      "cip.itemId",
      "cip.ordinal",
      "cip.partType",
      "cip.mimeType",
      "cip.textValue",
      "cip.jsonValue",
      "cip.refPath",
      "cip.refSha256",
      "cip.name",
      "cip.metadata",
    ])
    .where("cip.itemId", "in", itemIds)
    .orderBy("cip.itemId", "asc")
    .orderBy("cip.ordinal", "asc")
    .execute()

  const partsByItem = new Map<string, TableRow<"conversationItemParts">[]>()
  for (const row of partRows) {
    if (!partsByItem.has(row.itemId)) partsByItem.set(row.itemId, [])
    partsByItem.get(row.itemId)!.push(row)
  }

  return items.map((row: SessionMessageItemRow) => {
    const item = { ...row, parts: partsByItem.get(row.id) || [] }
    return {
      id: row.id,
      sessionId,
      conversationId: row.conversationId,
      sequence: row.sequence,
      workspaceId: row.workspaceId,
      role: normalizeSessionMessageRole(row),
      contentBlocks: itemPartsToCanonicalContentBlocks(item.parts || []),
      fromActorId: row.fromActorId || undefined,
      fromWorkspaceMemberId: row.fromWorkspaceMemberId || undefined,
      metadata: buildMetadataFromItem(item),
      createdAt: row.createdAt.toISOString() as SessionMessage["createdAt"],
    }
  })
}

// ============ Session Interrupts ============

export async function consumeInterrupts(sessionId: UUID): Promise<any[]> {
  return db
    .updateTable("sessionInterrupts")
    .set({
      isConsumed: true,
    })
    .where("targetSessionId", "=", sessionId)
    .where("isConsumed", "=", false)
    .returningAll()
    .execute()
}

export async function hasPendingInterrupt(
  sessionId: UUID,
  type?: SessionInterruptType
): Promise<boolean> {
  let query = db
    .selectFrom("sessionInterrupts")
    .select("id")
    .where("targetSessionId", "=", sessionId)
    .where("isConsumed", "=", false)

  if (type) {
    query = query.where("type", "=", type)
  }

  const row = await query.limit(1).executeTakeFirst()
  return Boolean(row?.id)
}
