import { pool, transaction } from "../../infrastructure/database/index.js";
import {
  db,
  executeCompiledQuery,
  executeTakeFirst,
  type TableInsert,
  type TableRow,
} from "../../infrastructure/database/kysely.js";
import {
  enqueueTransactionalEventDeliveries,
  type Queryable,
} from "../../infrastructure/events/index.js";
import { v4 as uuidv4 } from "uuid";
import { sql } from "kysely";
import type {
  ConversationEntityRef,
  ConversationFeedEventItem,
  ConversationFeedEventPayloadMap,
  ConversationFeedEventType,
  ConversationFeedItem,
  ConversationFeedMessageItem,
  ConversationMessageTransportContext,
  ConversationMessageTransportDelivery,
  ConversationEventContextPolicy,
  ConversationEventTimelinePolicy,
} from "@synapse/shared/types";
import { extractText, GROUP_CONVERSATION_KIND } from "@synapse/shared";
import { buildNormalizedMessageContent } from "./message-content.js";
import { itemPartsToCanonicalContentBlocks } from "./message-content.js";
import { getFileUrlById } from "../files/service.js";
import {
  getConversationEventSpec,
  renderConversationEventTimelineBlocks,
} from "./event-registry.js";
import {
  getWorkspaceMemberIdentity,
  getWorkspaceMemberIdentityById,
} from "./workspace-identity.js";

export type ConversationKind = "group" | "private" | "virtual";
export type ItemScope = "shared" | "private";
export type ItemSurface = "visible" | "internal";
export type ItemType = "message" | "event" | "summary" | "control";
export type ItemRole = "user" | "assistant" | "system" | "tool";

export interface ItemPartInput {
  type: "text" | "file_ref" | "json";
  text?: string;
  fileId?: string;
  json?: unknown;
  mimeType?: string;
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateConversationItemParams {
  workspaceId?: string;
  conversationId: string;
  sessionId?: string;
  turnId?: string;
  clientMessageId?: string;
  scope: ItemScope;
  surface: ItemSurface;
  itemType: ItemType;
  subtype: string;
  role: ItemRole;
  authorMemberId?: string;
  bundleId?: string;
  replyToItemId?: string;
  causedByItemId?: string;
  eventPayload?: Record<string, unknown>;
  eventTimelinePolicy?: ConversationEventTimelinePolicy;
  eventContextPolicy?: ConversationEventContextPolicy;
  metadata?: Record<string, unknown>;
  parts?: ItemPartInput[];
  targetMemberIds?: string[];
  contextTargetMemberIds?: string[];
  queryable?: Queryable;
}

export interface CreateConversationEventParams<
  T extends ConversationFeedEventType = ConversationFeedEventType,
> {
  workspaceId?: string;
  conversationId: string;
  sessionId?: string;
  turnId?: string;
  eventType: T;
  authorMemberId?: string;
  metadata?: Record<string, unknown>;
  eventPayload?: ConversationFeedEventPayloadMap[T];
  timelinePolicy?: ConversationEventTimelinePolicy;
  contextPolicy?: ConversationEventContextPolicy;
  targetMemberIds?: string[];
  contextTargetMemberIds?: string[];
  queryable?: Queryable;
}

function getDefaultQueryable(): Queryable {
  return pool;
}

async function resolveInternalConversationWorkspaceId(
  conversationId: string,
  internalWorkspaceId: string | null | undefined,
) {
  if (typeof internalWorkspaceId === "string" && internalWorkspaceId.trim()) {
    return internalWorkspaceId;
  }
  const member = await db
    .selectFrom("conversation_members as cm")
    .leftJoin("workspace_members as wm", "wm.id", "cm.workspace_member_id")
    .leftJoin("actors as a", "a.id", "cm.actor_id")
    .select([
      "wm.workspace_id as user_workspace_id",
      "a.workspace_id as actor_workspace_id",
    ])
    .where("cm.conversation_id", "=", conversationId)
    .where("cm.state", "=", "active")
    .limit(1)
    .executeTakeFirst();

  return member?.user_workspace_id || member?.actor_workspace_id || null;
}

async function resolveWorkspaceMemberBinding(params: {
  workspaceId?: string;
  workspaceMemberId?: string;
  userId?: string;
}) {
  if (params.workspaceMemberId) {
    return getWorkspaceMemberIdentityById(params.workspaceMemberId);
  }
  if (params.workspaceId && params.userId) {
    return getWorkspaceMemberIdentity(params.workspaceId, params.userId);
  }
  return null;
}

export async function listConversationRealtimeRecipients(
  conversationId: string,
  queryable?: Queryable,
) {
  const runner = queryable || getDefaultQueryable();
  const compiled = db
    .selectFrom("conversation_members as cm")
    .innerJoin("workspace_members as wm", "wm.id", "cm.workspace_member_id")
    .select([
      "cm.workspace_member_id",
      "wm.workspace_id",
    ])
    .where("cm.conversation_id", "=", conversationId)
    .where("cm.state", "=", "active")
    .where("cm.workspace_member_id", "is not", null)
    .compile();
  const result = await runner.query(compiled.sql, [...compiled.parameters]);
  return result.rows
    .map((row: any) => ({
      workspaceId: row.workspace_id as string,
      workspaceMemberId: row.workspace_member_id as string,
    }))
    .filter(
      (row) =>
        typeof row.workspaceId === "string" &&
        row.workspaceId &&
        typeof row.workspaceMemberId === "string" &&
        row.workspaceMemberId,
    );
}

async function insertConversationItem(
  queryable: Queryable,
  params: CreateConversationItemParams,
) {
  const itemId = uuidv4();
  const item = await executeTakeFirst<TableRow<"conversation_items">>(
    queryable,
    db
      .insertInto("conversation_items")
      .values({
        id: itemId,
        conversation_id: params.conversationId,
        session_id: params.sessionId || null,
        turn_id: params.turnId || null,
        client_message_id: params.clientMessageId || null,
        scope: params.scope,
        surface: params.surface,
        item_type: params.itemType,
        subtype: params.subtype,
        role: params.role,
        author_member_id: params.authorMemberId || null,
        bundle_id: params.bundleId || null,
        reply_to_item_id: params.replyToItemId || null,
        caused_by_item_id: params.causedByItemId || null,
        event_payload:
          (params.eventPayload || {}) as TableInsert<"conversation_items">["event_payload"],
        event_timeline_policy: params.eventTimelinePolicy || null,
        event_context_policy: params.eventContextPolicy || null,
        metadata:
          (params.metadata || {}) as TableInsert<"conversation_items">["metadata"],
      })
      .returningAll(),
  );
  if (!item) {
    throw new Error("Failed to create conversation item");
  }

  if (params.parts && params.parts.length > 0) {
    let ordinal = 0;
    for (const part of params.parts) {
      await executeCompiledQuery(
        queryable,
        db.insertInto("conversation_item_parts").values({
          id: uuidv4(),
          item_id: itemId,
          ordinal: ordinal++,
          part_type: part.type,
          text_value: part.type === "text" ? part.text || "" : null,
          file_id: part.type === "file_ref" ? part.fileId || null : null,
          json_value:
            part.type === "json"
              ? sql`${JSON.stringify(part.json ?? {})}::jsonb`
              : null,
          mime_type: part.mimeType || null,
          name: part.name || null,
          metadata:
            (part.metadata || {}) as TableInsert<"conversation_item_parts">["metadata"],
        }),
      );
    }
  }

  if (params.targetMemberIds && params.targetMemberIds.length > 0) {
    for (const targetMemberId of params.targetMemberIds) {
      await executeCompiledQuery(
        queryable,
        db.insertInto("conversation_item_targets").values({
          item_id: itemId,
          target_member_id: targetMemberId,
          target_kind: "to",
        }),
      );
    }
  }

  if (
    params.contextTargetMemberIds &&
    params.contextTargetMemberIds.length > 0
  ) {
    for (const targetMemberId of params.contextTargetMemberIds) {
      await executeCompiledQuery(
        queryable,
        db.insertInto("conversation_item_context_targets").values({
          item_id: itemId,
          target_member_id: targetMemberId,
        }),
      );
    }
  }

  await executeCompiledQuery(
    queryable,
    db
      .updateTable("conversations")
      .set({
        updated_at: sql`NOW()`,
      })
      .where("id", "=", params.conversationId),
  );

  if (params.scope === "shared" && params.surface === "visible") {
    const recipients = await listConversationRealtimeRecipients(
      params.conversationId,
      queryable,
    );
    await enqueueTransactionalEventDeliveries(queryable, {
      type: "feed.item.created",
      payload: {
        itemId,
      },
      timestamp: new Date().toISOString(),
      recipients,
    });
  }

  return item;
}

export async function createConversation(params: {
  kind: ConversationKind;
  boundary?: "internal" | "external";
  title?: string;
  createdBy?: string;
  metadata?: Record<string, unknown>;
}) {
  const boundary = params.boundary || "internal";
  const created = await db
    .insertInto("conversations")
    .values({
      id: uuidv4(),
      kind: params.kind,
      boundary,
      title: params.title || null,
      created_by: params.createdBy || null,
      metadata:
        (params.metadata || {}) as TableInsert<"conversations">["metadata"],
    })
    .returningAll()
    .executeTakeFirst();

  if (!created) {
    throw new Error("Failed to create conversation");
  }

  return created;
}

export async function getConversation(conversationId: string) {
  return (
    (await db
      .selectFrom("conversations")
      .selectAll()
      .where("id", "=", conversationId)
      .executeTakeFirst()) ?? null
  );
}

export async function ensureConversationMember(params: {
  conversationId: string;
  memberType: "actor" | "user" | "external" | "remote_agent" | "system";
  workspaceId?: string;
  workspaceMemberId?: string;
  actorId?: string;
  userId?: string;
  displayName?: string;
  actorJoinVersionId?: string;
  role?: "owner" | "admin" | "member";
  metadata?: Record<string, unknown>;
}) {
  const result = await ensureConversationMemberActivation(params);
  return result.member;
}

export async function ensureConversationMemberActivation(params: {
  conversationId: string;
  memberType: "actor" | "user" | "external" | "remote_agent" | "system";
  workspaceId?: string;
  workspaceMemberId?: string;
  actorId?: string;
  userId?: string;
  displayName?: string;
  actorJoinVersionId?: string;
  role?: "owner" | "admin" | "member";
  metadata?: Record<string, unknown>;
}): Promise<{
  member: any;
  activated: boolean;
  created: boolean;
  revived: boolean;
}> {
  const {
    conversationId,
    memberType,
    workspaceId,
    workspaceMemberId,
    actorId,
    userId,
    displayName,
    actorJoinVersionId,
    role = "member",
    metadata = {},
  } = params;
  const resolvedUserMember =
    memberType === "user"
      ? await resolveWorkspaceMemberBinding({
          workspaceId,
          workspaceMemberId,
          userId,
        })
      : null;
  const resolvedWorkspaceMemberId =
    memberType === "user" ? resolvedUserMember?.workspaceMemberId || null : null;
  const resolvedUserId =
    memberType === "user" ? resolvedUserMember?.userId || userId || null : null;
  const conversation = await getConversation(conversationId);

  if (!conversation) {
    throw new Error("Conversation not found");
  }

  if (memberType === "user" && (!resolvedWorkspaceMemberId || !resolvedUserId)) {
    throw new Error("Workspace member identity is required for user participants");
  }

  if (conversation.boundary === "internal") {
    if (
      memberType === "external" ||
      memberType === "remote_agent"
    ) {
      throw new Error(
        "Internal conversations do not allow external participants",
      );
    }

    const internalWorkspaceId = await resolveInternalConversationWorkspaceId(
      conversationId,
      conversation.internal_workspace_id,
    );
    let participantWorkspaceId: string | null = null;

    if (memberType === "user") {
      participantWorkspaceId = resolvedUserMember?.workspaceId || null;
    } else if (memberType === "actor" && actorId) {
      const actor = await db
        .selectFrom("actors")
        .select(["workspace_id"])
        .where("id", "=", actorId)
        .executeTakeFirst();
      participantWorkspaceId = actor?.workspace_id || null;
    }

    if (
      internalWorkspaceId &&
      participantWorkspaceId &&
      participantWorkspaceId !== internalWorkspaceId
    ) {
      throw new Error(
        "Internal conversations only allow participants from the internal workspace",
      );
    }
  }

  let existing;

  if (memberType === "actor") {
    let actorLookup = db
      .selectFrom("conversation_members")
      .selectAll()
      .where("conversation_id", "=", conversationId);
    actorLookup = actorId
      ? actorLookup.where("actor_id", "=", actorId)
      : actorLookup.where("actor_id", "is", null);
    existing = await actorLookup.limit(1).executeTakeFirst();
  } else if (memberType === "user") {
    let userLookup = db
      .selectFrom("conversation_members")
      .selectAll()
      .where("conversation_id", "=", conversationId);
    userLookup = resolvedWorkspaceMemberId
      ? userLookup.where("workspace_member_id", "=", resolvedWorkspaceMemberId)
      : resolvedUserId
        ? userLookup.where("user_id", "=", resolvedUserId)
        : userLookup.where("workspace_member_id", "is", null);
    existing = await userLookup.limit(1).executeTakeFirst();
  } else if (
    memberType === "external" &&
    typeof metadata.externalUserKey === "string" &&
    metadata.externalUserKey.trim()
  ) {
    existing = await db
      .selectFrom("conversation_members")
      .selectAll()
      .where("conversation_id", "=", conversationId)
      .where("member_type", "=", "external")
      .where(
        sql<boolean>`metadata->>'externalUserKey' = ${metadata.externalUserKey.trim()}`,
      )
      .limit(1)
      .executeTakeFirst();
  } else {
    existing = await db
      .selectFrom("conversation_members")
      .selectAll()
      .where("conversation_id", "=", conversationId)
      .where("member_type", "=", memberType)
      .where(
        sql<boolean>`COALESCE(display_name, '') = COALESCE(${displayName || null}, '')`,
      )
      .limit(1)
      .executeTakeFirst();
  }

  if (existing) {
    if (existing.state !== "active") {
      const revived = await db
        .updateTable("conversation_members")
        .set({
          state: "active",
          left_at: null,
          role,
          ...(memberType === "user"
            ? {
                workspace_member_id: resolvedWorkspaceMemberId,
                user_id: resolvedUserId,
              }
            : {}),
          ...(actorJoinVersionId
            ? { actor_join_version_id: actorJoinVersionId }
            : {}),
          metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify(metadata)}::jsonb`,
        })
        .where("id", "=", existing.id)
        .returningAll()
        .executeTakeFirst();
      if (!revived) {
        throw new Error("Failed to reactivate conversation member");
      }
      return {
        member: revived,
        activated: true,
        created: false,
        revived: true,
      };
    }
    return {
      member: existing,
      activated: false,
      created: false,
      revived: false,
    };
  }

  const created = await db
    .insertInto("conversation_members")
    .values({
      id: uuidv4(),
      conversation_id: conversationId,
      member_type: memberType,
      actor_id: actorId || null,
      workspace_member_id: resolvedWorkspaceMemberId,
      user_id: resolvedUserId,
      actor_join_version_id: actorJoinVersionId || null,
      display_name: displayName || null,
      role,
      state: "active",
      metadata:
        (metadata || {}) as TableInsert<"conversation_members">["metadata"],
    })
    .returningAll()
    .executeTakeFirst();
  if (!created) {
    throw new Error("Failed to create conversation member");
  }

  return {
    member: created,
    activated: true,
    created: true,
    revived: false,
  };
}

export async function getConversationMember(params: {
  conversationId: string;
  actorId?: string;
  workspaceMemberId?: string;
  userId?: string;
}) {
  const { conversationId, actorId, workspaceMemberId, userId } = params;
  if (actorId) {
    return (
      (await db
        .selectFrom("conversation_members")
        .selectAll()
        .where("conversation_id", "=", conversationId)
        .where("actor_id", "=", actorId)
        .executeTakeFirst()) ?? null
    );
  } else if (workspaceMemberId) {
    return (
      (await db
        .selectFrom("conversation_members")
        .selectAll()
        .where("conversation_id", "=", conversationId)
        .where("workspace_member_id", "=", workspaceMemberId)
        .executeTakeFirst()) ?? null
    );
  } else if (userId) {
    return (
      (await db
        .selectFrom("conversation_members")
        .selectAll()
        .where("conversation_id", "=", conversationId)
        .where("user_id", "=", userId)
        .executeTakeFirst()) ?? null
    );
  } else {
    return null;
  }
}

export async function listConversationMembers(conversationId: string) {
  return db
    .selectFrom("conversation_members as cm")
    .leftJoin("actors as a", "a.id", "cm.actor_id")
    .leftJoin("workspace_members as wm", "wm.id", "cm.workspace_member_id")
    .leftJoin("users as u", "u.id", "cm.user_id")
    .selectAll("cm")
    .select([
      "wm.id as workspace_member_id",
      "wm.workspace_id as member_workspace_id",
      "a.name as actor_name",
      "a.title as actor_title",
      "a.role as actor_role",
      "u.name as user_name",
    ])
    .where("cm.conversation_id", "=", conversationId)
    .orderBy("cm.joined_at", "asc")
    .execute();
}

function uniqueIds(ids: string[]) {
  return [...new Set(ids.filter(Boolean))];
}

async function resolveEventTimelineTargets(params: {
  conversationId: string;
  timelinePolicy: ConversationEventTimelinePolicy;
  explicitTargetMemberIds?: string[];
}) {
  if (
    params.timelinePolicy === "none" ||
    params.timelinePolicy === "all_members"
  ) {
    return [];
  }

  const members = await listConversationMembers(params.conversationId);
  if (params.timelinePolicy === "targeted_members") {
    return uniqueIds(params.explicitTargetMemberIds || []);
  }

  if (params.timelinePolicy === "users_only") {
    return uniqueIds(
      members
        .filter((member: any) => member.state === "active" && member.user_id)
        .map((member: any) => member.id),
    );
  }

  if (params.timelinePolicy === "actors_only") {
    return uniqueIds(
      members
        .filter((member: any) => member.state === "active" && member.actor_id)
        .map((member: any) => member.id),
    );
  }

  return [];
}

async function resolveEventContextTargets(params: {
  conversationId: string;
  contextPolicy: ConversationEventContextPolicy;
  explicitContextTargetMemberIds?: string[];
}) {
  if (params.contextPolicy === "none") {
    return [];
  }

  const members = await listConversationMembers(params.conversationId);
  if (params.contextPolicy === "shared") {
    return uniqueIds(
      members
        .filter((member: any) => member.state === "active" && member.actor_id)
        .map((member: any) => member.id),
    );
  }

  const explicitTargets = uniqueIds(
    params.explicitContextTargetMemberIds || [],
  );
  if (explicitTargets.length === 0) {
    return [];
  }

  const activeActorTargets = new Set(
    members
      .filter((member: any) => member.state === "active" && member.actor_id)
      .map((member: any) => member.id),
  );

  return explicitTargets.filter((targetMemberId) =>
    activeActorTargets.has(targetMemberId),
  );
}

export async function createConversationItem(
  params: CreateConversationItemParams,
) {
  if (params.queryable) {
    return insertConversationItem(params.queryable, params);
  }

  return transaction(async (client) => insertConversationItem(client, params));
}

export async function createConversationEvent(
  params: CreateConversationEventParams,
) {
  const spec = getConversationEventSpec(params.eventType);
  const timelinePolicy = params.timelinePolicy || spec.timelinePolicy;
  const contextPolicy = params.contextPolicy || spec.contextPolicy;
  const eventPayload = params.eventPayload || {};

  const timelineTargetMemberIds = await resolveEventTimelineTargets({
    conversationId: params.conversationId,
    timelinePolicy,
    explicitTargetMemberIds: params.targetMemberIds,
  });
  const contextTargetMemberIds = await resolveEventContextTargets({
    conversationId: params.conversationId,
    contextPolicy,
    explicitContextTargetMemberIds: params.contextTargetMemberIds,
  });

  const normalizedTimeline = await buildNormalizedMessageContent({
    content: "",
    contentBlocks: renderConversationEventTimelineBlocks(
      params.eventType,
      eventPayload,
    ),
    metadata: params.metadata || {},
  });

  const item = await createConversationItem({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    sessionId: params.sessionId,
    turnId: params.turnId,
    scope: "shared",
    surface: timelinePolicy === "none" ? "internal" : "visible",
    itemType: "event",
    subtype: params.eventType,
    role: "system",
    authorMemberId: params.authorMemberId,
    eventPayload,
    eventTimelinePolicy: timelinePolicy,
    eventContextPolicy: contextPolicy,
    metadata: params.metadata || {},
    parts: normalizedTimeline.parts,
    targetMemberIds: timelineTargetMemberIds,
    contextTargetMemberIds,
    queryable: params.queryable,
  });

  return {
    item,
    timelinePolicy,
    contextPolicy,
    timelineTargetMemberIds,
    contextTargetMemberIds,
    timelineContent: normalizedTimeline.normalizedContent,
    timelineContentBlocks: normalizedTimeline.contentBlocks,
    metadata: normalizedTimeline.normalizedMetadata,
    eventPayload,
  };
}

export async function markConversationRead(
  userId: string,
  conversationId: string,
  lastReadSequence?: number,
  queryable?: Queryable,
  workspaceMemberId?: string,
) {
  const resolvedWorkspaceMemberId =
    workspaceMemberId ||
    (
      await getConversationMember({
        conversationId,
        userId,
      })
    )?.workspace_member_id;
  if (!resolvedWorkspaceMemberId) {
    throw new Error("Conversation member not found for read state");
  }
  const runner = queryable || getDefaultQueryable();
  await executeCompiledQuery(
    runner,
    db
      .insertInto("conversation_user_states")
      .values({
        workspace_member_id: resolvedWorkspaceMemberId,
        user_id: userId,
        conversation_id: conversationId,
        read_watermark_sequence: Math.max(0, Number(lastReadSequence || 0)),
        last_read_at: sql`NOW()`,
        updated_at: sql`NOW()`,
      })
      .onConflict((oc) =>
        oc.columns(["workspace_member_id", "conversation_id"]).doUpdateSet({
          read_watermark_sequence:
            sql`GREATEST(conversation_user_states.read_watermark_sequence, excluded.read_watermark_sequence)`,
          last_read_at: sql`NOW()`,
          updated_at: sql`NOW()`,
        }),
      ),
  );
}

export async function getConversationReadState(
  userId: string,
  conversationId: string,
  queryable?: Queryable,
  workspaceMemberId?: string,
) {
  const resolvedWorkspaceMemberId =
    workspaceMemberId ||
    (
      await getConversationMember({
        conversationId,
        userId,
      })
    )?.workspace_member_id;
  if (!resolvedWorkspaceMemberId) {
    return {
      readWatermarkSequence: 0,
      lastReadAt: undefined,
    };
  }
  const runner = queryable || getDefaultQueryable();
  const row = await executeTakeFirst<{
    read_watermark_sequence: string | number | null;
    last_read_at: string | Date | null;
  }>(
    runner,
    db
      .selectFrom("conversation_user_states")
      .select(["read_watermark_sequence", "last_read_at"])
      .where("workspace_member_id", "=", resolvedWorkspaceMemberId)
      .where("conversation_id", "=", conversationId)
      .limit(1),
  );
  return {
    readWatermarkSequence: row?.read_watermark_sequence
      ? Number(row.read_watermark_sequence)
      : 0,
    lastReadAt: (row?.last_read_at as string | null | undefined) || undefined,
  };
}

export async function updateConversationItemEventPayload(
  itemId: string,
  payload: Record<string, unknown>,
  queryable?: Queryable,
) {
  const runner = queryable || getDefaultQueryable();
  await executeCompiledQuery(
    runner,
    db
      .updateTable("conversation_items")
      .set({
        event_payload:
          payload as TableInsert<"conversation_items">["event_payload"],
      })
      .where("id", "=", itemId),
  );
}

export async function resolveReadableConversationSequenceForUser(params: {
  conversationId: string;
  userId?: string;
  workspaceMemberId?: string;
  maxSequence?: number;
}) {
  if (!params.workspaceMemberId && !params.userId) {
    return 0;
  }
  let statement = db
    .selectFrom("conversation_items as ci")
    .innerJoin("conversations as c", "c.id", "ci.conversation_id")
    .innerJoin("conversation_members as cm_u", (join) =>
      join
        .onRef("cm_u.conversation_id", "=", "c.id")
        .on("cm_u.state", "=", "active"),
    )
    .select(({ fn }) => fn.max("ci.sequence").as("sequence"))
    .where("ci.conversation_id", "=", params.conversationId)
    .where("ci.scope", "=", "shared")
    .where("ci.surface", "=", "visible")
    .where((eb) =>
      eb.or([
        eb.and([
          eb("c.kind", "=", GROUP_CONVERSATION_KIND),
          eb("ci.item_type", "=", "message"),
          eb("ci.subtype", "<>", "model_error_notice"),
        ]),
        sql<boolean>`ci.author_member_id = cm_u.id`,
        sql<boolean>`NOT EXISTS (
          SELECT 1
          FROM conversation_item_targets cit0
          WHERE cit0.item_id = ci.id
        )`,
        sql<boolean>`EXISTS (
          SELECT 1
          FROM conversation_item_targets cit
          WHERE cit.item_id = ci.id
            AND cit.target_member_id = cm_u.id
        )`,
      ]),
    );

  if (params.workspaceMemberId) {
    statement = statement.where(
      "cm_u.workspace_member_id",
      "=",
      params.workspaceMemberId,
    );
  } else if (params.userId) {
    statement = statement.where("cm_u.user_id", "=", params.userId);
  }

  if (
    typeof params.maxSequence === "number" &&
    Number.isFinite(params.maxSequence) &&
    params.maxSequence > 0
  ) {
    statement = statement.where(
      "ci.sequence",
      "<=",
      String(Math.floor(params.maxSequence)),
    );
  }

  const result = await statement.executeTakeFirst();
  const sequence = result?.sequence;
  return sequence ? Number(sequence) : 0;
}

async function loadItemsWithRelations(itemRows: any[]) {
  if (itemRows.length === 0) return [];

  const itemIds = itemRows.map((row) => row.id);
  const [partsResult, targetsResult, contextTargetsResult, transportDeliveriesResult] =
    await Promise.all([
      db
        .selectFrom("conversation_item_parts as cip")
        .leftJoin("files as f", "f.id", "cip.file_id")
        .select([
          "cip.id",
          "cip.item_id",
          "cip.ordinal",
          "cip.part_type",
          "cip.text_value",
          "cip.file_id",
          "cip.json_value",
          "cip.mime_type",
          "cip.name",
          "cip.metadata",
          "f.original_name",
          "f.stored_name",
          "f.mime_type as file_mime_type",
          "f.size_bytes",
        ])
        .where("cip.item_id", "in", itemIds)
        .orderBy("cip.item_id", "asc")
        .orderBy("cip.ordinal", "asc")
        .execute(),
      db.executeQuery(
        sql<any>`
          SELECT cit.item_id,
                 cit.target_kind,
                 ${sql.raw(
                   buildEntitySelect({
                     memberAlias: "cm",
                     actorAlias: "a",
                     userAlias: "u",
                     addressAlias: "primary_address",
                   }),
                 )}
          FROM conversation_item_targets cit
          JOIN conversation_members cm ON cm.id = cit.target_member_id
          LEFT JOIN actors a ON a.id = cm.actor_id
          LEFT JOIN users u ON u.id = cm.user_id
          ${sql.raw(buildPrimaryTransportAddressJoin("cm", "primary_address"))}
          WHERE cit.item_id = ANY(${itemIds}::uuid[])
          ORDER BY cit.item_id
        `.compile(db),
      ),
      db.executeQuery(
        sql<any>`
          SELECT cict.item_id,
                 ${sql.raw(
                   buildEntitySelect({
                     memberAlias: "cm",
                     actorAlias: "a",
                     userAlias: "u",
                     addressAlias: "primary_address",
                   }),
                 )}
          FROM conversation_item_context_targets cict
          JOIN conversation_members cm ON cm.id = cict.target_member_id
          LEFT JOIN actors a ON a.id = cm.actor_id
          LEFT JOIN users u ON u.id = cm.user_id
          ${sql.raw(buildPrimaryTransportAddressJoin("cm", "primary_address"))}
          WHERE cict.item_id = ANY(${itemIds}::uuid[])
          ORDER BY cict.item_id
        `.compile(db),
      ),
      db
        .selectFrom("transport_message_links as tml")
        .innerJoin(
          "transport_endpoints as te",
          "te.id",
          "tml.transport_endpoint_id",
        )
        .select([
          "tml.item_id",
          "tml.id as link_id",
          "tml.transport_kind",
          "tml.direction",
          "tml.delivery_status",
          "tml.external_message_id",
          "tml.metadata",
          "tml.delivered_at",
          "te.endpoint_type",
          "te.external_id as endpoint_external_id",
          "te.display_name as endpoint_display_name",
        ])
        .where("tml.item_id", "in", itemIds)
        .orderBy("tml.item_id", "asc")
        .orderBy("tml.created_at", "asc")
        .execute(),
    ]);

  const partsByItem = new Map<string, any[]>();
  for (const row of partsResult) {
    if (!partsByItem.has(row.item_id)) partsByItem.set(row.item_id, []);
    partsByItem.get(row.item_id)!.push(row);
  }

  const targetsByItem = new Map<string, any[]>();
  for (const row of targetsResult.rows) {
    if (!targetsByItem.has(row.item_id)) targetsByItem.set(row.item_id, []);
    targetsByItem.get(row.item_id)!.push(row);
  }

  const contextTargetsByItem = new Map<string, any[]>();
  for (const row of contextTargetsResult.rows) {
    if (!contextTargetsByItem.has(row.item_id))
      contextTargetsByItem.set(row.item_id, []);
    contextTargetsByItem.get(row.item_id)!.push(row);
  }

  const transportDeliveriesByItem = new Map<string, any[]>();
  for (const row of transportDeliveriesResult) {
    if (!transportDeliveriesByItem.has(row.item_id)) {
      transportDeliveriesByItem.set(row.item_id, []);
    }
    transportDeliveriesByItem.get(row.item_id)!.push(row);
  }

  return itemRows.map((row) => ({
    ...row,
    created_at:
      row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    parts: partsByItem.get(row.id) || [],
    targets: targetsByItem.get(row.id) || [],
    context_targets: contextTargetsByItem.get(row.id) || [],
    transport_deliveries: (transportDeliveriesByItem.get(row.id) || []).map(
      (delivery) => ({
        ...delivery,
        delivered_at:
          delivery.delivered_at instanceof Date
            ? delivery.delivered_at.toISOString()
            : delivery.delivered_at,
      }),
    ),
  }));
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function buildPrimaryTransportAddressJoin(
  memberAlias: string,
  addressAlias: string,
) {
  return `LEFT JOIN LATERAL (
            SELECT ta.id,
                   ta.transport_kind,
                   ta.external_id,
                   COALESCE(ta.display_name, ${memberAlias}.display_name) AS display_name
            FROM conversation_participant_addresses cpa
            JOIN transport_addresses ta ON ta.id = cpa.transport_address_id
            WHERE cpa.conversation_member_id = ${memberAlias}.id
            ORDER BY cpa.is_primary DESC, cpa.created_at ASC
            LIMIT 1
          ) ${addressAlias} ON TRUE`;
}

function buildEntitySelect(params: {
  memberAlias: string;
  actorAlias: string;
  userAlias: string;
  addressAlias: string;
  prefix?: string;
}) {
  const prefix = params.prefix || "";
  return `${params.memberAlias}.id AS ${prefix}member_id,
          ${params.memberAlias}.member_type AS ${prefix}member_type,
          ${params.memberAlias}.workspace_member_id AS ${prefix}workspace_member_id,
          ${params.memberAlias}.actor_id AS ${prefix}actor_id,
          ${params.memberAlias}.user_id AS ${prefix}user_id,
          COALESCE(
            ${params.memberAlias}.metadata->>'externalUserKey',
            CASE
              WHEN ${params.addressAlias}.transport_kind IS NOT NULL
               AND ${params.addressAlias}.external_id IS NOT NULL
              THEN ${params.addressAlias}.transport_kind || ':' || ${params.addressAlias}.external_id
              ELSE NULL
            END
          ) AS ${prefix}external_user_key,
          ${params.addressAlias}.id AS ${prefix}transport_address_id,
          ${params.addressAlias}.transport_kind AS ${prefix}transport_kind,
          COALESCE(
            ${params.actorAlias}.name,
            ${params.userAlias}.name,
            ${params.addressAlias}.display_name,
            ${params.memberAlias}.display_name
          ) AS ${prefix}name,
          ${params.actorAlias}.title AS ${prefix}title,
          ${params.actorAlias}.role AS ${prefix}role,
          ${params.actorAlias}.avatar_file_id AS ${prefix}actor_avatar_file_id,
          ${params.actorAlias}.avatar_emoji AS ${prefix}avatar_emoji,
          ${params.userAlias}.avatar_file_id AS ${prefix}user_avatar_file_id`;
}

function mapEntityRef(row: any): ConversationEntityRef | undefined {
  if (!row) return undefined;
  const memberType = row.member_type || row.author_member_type;
  if (!memberType) return undefined;
  const participantId = row.member_id || row.author_member_id || row.id;
  return {
    memberId: participantId,
    participantId,
    memberType,
    workspaceMemberId:
      row.workspace_member_id || row.author_workspace_member_id || undefined,
    actorId: row.actor_id || row.author_actor_id || undefined,
    userId: row.user_id || row.author_user_id || undefined,
    externalUserKey:
      row.external_user_key || row.author_external_user_key || undefined,
    transportAddressId:
      row.transport_address_id || row.author_transport_address_id || undefined,
    transportKind:
      row.transport_kind || row.author_transport_kind || undefined,
    name: row.member_name || row.name || row.author_name || undefined,
    title: row.title || row.actor_title || row.author_title || undefined,
    role: row.role || row.actor_role || row.author_role || undefined,
    avatarUrl: row.avatar_url
      || (row.actor_avatar_file_id || row.author_actor_avatar_file_id
        ? getFileUrlById(row.actor_avatar_file_id || row.author_actor_avatar_file_id)
        : row.user_avatar_file_id || row.author_user_avatar_file_id
          ? getFileUrlById(row.user_avatar_file_id || row.author_user_avatar_file_id)
          : undefined),
    avatarEmoji: row.avatar_emoji || row.author_avatar_emoji || undefined,
  };
}

function mapTargets(rows: any[]): ConversationEntityRef[] {
  return rows
    .map((row) => mapEntityRef(row))
    .filter((row): row is ConversationEntityRef => Boolean(row));
}

function buildTextContentFromParts(parts: any[]) {
  return extractText(itemPartsToCanonicalContentBlocks(parts || []));
}

function mapMessageTransportContext(
  metadata: Record<string, unknown>,
): ConversationMessageTransportContext | undefined {
  const raw = metadata.transport;
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const value = raw as Record<string, unknown>;
  const direction =
    value.direction === "inbound" || value.direction === "outbound"
      ? value.direction
      : undefined;
  const transportKind =
    value.transportKind === "feishu" || value.transportKind === "weixin"
      ? value.transportKind
      : undefined;
  if (!direction || !transportKind) {
    return undefined;
  }

  return {
    direction,
    transportKind,
    transportAccountId:
      typeof value.transportAccountId === "string"
        ? value.transportAccountId
        : undefined,
    endpointType:
      value.endpointType === "direct" || value.endpointType === "group"
        ? value.endpointType
        : undefined,
    endpointExternalId:
      typeof value.endpointExternalId === "string"
        ? value.endpointExternalId
        : undefined,
    externalMessageId:
      typeof value.externalMessageId === "string"
        ? value.externalMessageId
        : undefined,
    transportAddressId:
      typeof value.transportAddressId === "string"
        ? value.transportAddressId
        : undefined,
    senderExternalId:
      typeof value.senderExternalId === "string"
        ? value.senderExternalId
        : undefined,
  };
}

function mapTransportDeliveries(
  rows: any[],
): ConversationMessageTransportDelivery[] {
  return rows.map((row) => ({
    linkId: row.link_id,
    transportKind: row.transport_kind,
    direction: row.direction,
    deliveryStatus: row.delivery_status,
    endpointType: row.endpoint_type || undefined,
    endpointExternalId: row.endpoint_external_id || undefined,
    endpointDisplayName: row.endpoint_display_name || undefined,
    externalMessageId: row.external_message_id || undefined,
    deliveredAt: row.delivered_at || undefined,
    metadata: parseJsonObject(row.metadata),
  }));
}

export function conversationItemRowToFeedItem(row: any): ConversationFeedItem {
  const author = mapEntityRef({
    author_member_id: row.author_member_id,
    author_member_type: row.author_member_type,
    author_actor_id: row.author_actor_id,
    author_user_id: row.author_user_id,
    author_external_user_key: row.author_external_user_key,
    author_transport_address_id: row.author_transport_address_id,
    author_transport_kind: row.author_transport_kind,
    author_name: row.author_name,
    author_title: row.author_title,
    author_role: row.author_role,
  });
  const base = {
    itemId: row.id,
    conversationId: row.conversation_id,
    sequence: Number(row.sequence),
    sessionId: row.session_id || undefined,
    turnId: row.turn_id || undefined,
    author,
    createdAt: row.created_at,
  };

  if (row.item_type === "event") {
    return {
      kind: "event",
      ...base,
      targets: mapTargets(row.targets || []),
      causedByItemId: row.caused_by_item_id || undefined,
      eventType: row.subtype,
      payload: parseJsonObject(
        row.event_payload,
      ) as ConversationFeedEventItem["payload"],
    };
  }

  const metadata = parseJsonObject(row.metadata);
  return {
    kind: "message",
    ...base,
    role: row.role,
    messageType: row.subtype || "chat",
    targets: mapTargets(row.targets || []),
    content: buildTextContentFromParts(row.parts || []),
    contentBlocks: itemPartsToCanonicalContentBlocks(row.parts || []),
    metadata,
    transport: mapMessageTransportContext(metadata),
    transportDeliveries: mapTransportDeliveries(row.transport_deliveries || []),
    clientMessageId: row.client_message_id || undefined,
  } satisfies ConversationFeedMessageItem;
}

export function isFeedItemVisibleToUser(
  item: ConversationFeedItem,
  userId: string,
) {
  if (item.kind === "message") {
    if (item.messageType === "model_error_notice") {
      if (!item.targets || item.targets.length === 0) {
        return true;
      }

      if (item.author?.userId === userId) {
        return true;
      }

      return item.targets.some((target) => target.userId === userId);
    }

    return true;
  }

  if (!item.targets || item.targets.length === 0) {
    return true;
  }

  if (item.author?.userId === userId) {
    return true;
  }

  return item.targets.some((target) => target.userId === userId);
}

export function isFeedItemVisibleToWorkspaceMember(
  item: ConversationFeedItem,
  workspaceMemberId: string,
) {
  if (item.kind === "message") {
    if (item.messageType === "model_error_notice") {
      if (!item.targets || item.targets.length === 0) {
        return true;
      }

      if (item.author?.workspaceMemberId === workspaceMemberId) {
        return true;
      }

      return item.targets.some(
        (target) => target.workspaceMemberId === workspaceMemberId,
      );
    }

    return true;
  }

  if (!item.targets || item.targets.length === 0) {
    return true;
  }

  if (item.author?.workspaceMemberId === workspaceMemberId) {
    return true;
  }

  return item.targets.some(
    (target) => target.workspaceMemberId === workspaceMemberId,
  );
}

export async function getConversationFeedItemById(itemId: string) {
  const result = await db.executeQuery(
    sql<any>`
      SELECT ci.*,
             ${sql.raw(
               buildEntitySelect({
                 memberAlias: "cm",
                 actorAlias: "a",
                 userAlias: "u",
                 addressAlias: "author_primary_address",
                 prefix: "author_",
               }),
             )}
      FROM conversation_items ci
      LEFT JOIN conversation_members cm ON cm.id = ci.author_member_id
      LEFT JOIN actors a ON a.id = cm.actor_id
      LEFT JOIN users u ON u.id = cm.user_id
      ${sql.raw(buildPrimaryTransportAddressJoin("cm", "author_primary_address"))}
      WHERE ci.id = ${itemId}
      LIMIT 1
    `.compile(db),
  );
  const [item] = await loadItemsWithRelations(result.rows);
  return item ? conversationItemRowToFeedItem(item) : null;
}

export async function getVisibleConversationItemsForMember(params: {
  conversationId: string;
  memberId: string;
  beforeSequence?: number;
  limit?: number;
}) {
  const { conversationId, memberId, beforeSequence, limit = 200 } = params;
  const beforeClause =
    beforeSequence !== undefined
      ? sql`AND ci.sequence < ${beforeSequence}`
      : sql``;

  const items = await db.executeQuery(
    sql<any>`
      SELECT ci.*,
             c.kind AS conversation_kind,
             ${sql.raw(
               buildEntitySelect({
                 memberAlias: "cm",
                 actorAlias: "a",
                 userAlias: "u",
                 addressAlias: "author_primary_address",
                 prefix: "author_",
               }),
             )}
      FROM conversation_items ci
      JOIN conversations c ON c.id = ci.conversation_id
      LEFT JOIN conversation_members cm ON cm.id = ci.author_member_id
      LEFT JOIN actors a ON a.id = cm.actor_id
      LEFT JOIN users u ON u.id = cm.user_id
      ${sql.raw(buildPrimaryTransportAddressJoin("cm", "author_primary_address"))}
      WHERE ci.conversation_id = ${conversationId}
        AND ci.scope = 'shared'
        AND ci.surface = 'visible'
        AND (
          (c.kind = ${GROUP_CONVERSATION_KIND} AND ci.item_type = 'message' AND ci.subtype <> 'model_error_notice')
          OR ci.author_member_id = ${memberId}
          OR NOT EXISTS (SELECT 1 FROM conversation_item_targets cit0 WHERE cit0.item_id = ci.id)
          OR EXISTS (
            SELECT 1 FROM conversation_item_targets cit
            WHERE cit.item_id = ci.id AND cit.target_member_id = ${memberId}
          )
        )
        ${beforeClause}
      ORDER BY ci.sequence DESC
      LIMIT ${limit}
    `.compile(db),
  );

  const loaded = await loadItemsWithRelations(items.rows);
  return loaded.reverse();
}

export async function getSharedVisibleConversationItems(params: {
  conversationId: string;
  beforeSequence?: number;
  limit?: number;
}) {
  const { conversationId, beforeSequence, limit = 200 } = params;
  const beforeClause =
    beforeSequence !== undefined
      ? sql`AND ci.sequence < ${beforeSequence}`
      : sql``;

  const items = await db.executeQuery(
    sql<any>`
      SELECT ci.*,
             c.kind AS conversation_kind,
             ${sql.raw(
               buildEntitySelect({
                 memberAlias: "cm",
                 actorAlias: "a",
                 userAlias: "u",
                 addressAlias: "author_primary_address",
                 prefix: "author_",
               }),
             )}
      FROM conversation_items ci
      JOIN conversations c ON c.id = ci.conversation_id
      LEFT JOIN conversation_members cm ON cm.id = ci.author_member_id
      LEFT JOIN actors a ON a.id = cm.actor_id
      LEFT JOIN users u ON u.id = cm.user_id
      ${sql.raw(buildPrimaryTransportAddressJoin("cm", "author_primary_address"))}
      WHERE ci.conversation_id = ${conversationId}
        AND ci.scope = 'shared'
        AND ci.surface = 'visible'
        ${beforeClause}
      ORDER BY ci.sequence DESC
      LIMIT ${limit}
    `.compile(db),
  );

  const loaded = await loadItemsWithRelations(items.rows);
  return loaded.reverse();
}

export async function getContextConversationItemsForMember(params: {
  conversationId: string;
  memberId: string;
  beforeSequence?: number;
  limit?: number;
}) {
  const { conversationId, memberId, beforeSequence, limit = 200 } = params;
  const beforeClause =
    beforeSequence !== undefined
      ? sql`AND ci.sequence < ${beforeSequence}`
      : sql``;

  const items = await db.executeQuery(
    sql<any>`
      SELECT ci.*,
             c.kind AS conversation_kind,
             ${sql.raw(
               buildEntitySelect({
                 memberAlias: "cm",
                 actorAlias: "a",
                 userAlias: "u",
                 addressAlias: "author_primary_address",
                 prefix: "author_",
               }),
             )}
      FROM conversation_items ci
      JOIN conversations c ON c.id = ci.conversation_id
      LEFT JOIN conversation_members cm ON cm.id = ci.author_member_id
      LEFT JOIN actors a ON a.id = cm.actor_id
      LEFT JOIN users u ON u.id = cm.user_id
      ${sql.raw(buildPrimaryTransportAddressJoin("cm", "author_primary_address"))}
      WHERE ci.conversation_id = ${conversationId}
        AND ci.scope = 'shared'
        AND (
          (
            ci.surface = 'visible'
            AND (
              (c.kind = ${GROUP_CONVERSATION_KIND} AND ci.item_type = 'message' AND ci.subtype <> 'model_error_notice')
              OR ci.author_member_id = ${memberId}
              OR NOT EXISTS (SELECT 1 FROM conversation_item_targets cit0 WHERE cit0.item_id = ci.id)
              OR EXISTS (
                SELECT 1 FROM conversation_item_targets cit
                WHERE cit.item_id = ci.id AND cit.target_member_id = ${memberId}
              )
            )
          )
          OR EXISTS (
            SELECT 1 FROM conversation_item_context_targets cict
            WHERE cict.item_id = ci.id AND cict.target_member_id = ${memberId}
          )
        )
        ${beforeClause}
      ORDER BY ci.sequence DESC
      LIMIT ${limit}
    `.compile(db),
  );

  const loaded = await loadItemsWithRelations(items.rows);
  return loaded.reverse();
}

export async function getPrivateSessionItems(sessionId: string) {
  const items = await db.executeQuery(
    sql<any>`
      SELECT ci.*,
             ${sql.raw(
               buildEntitySelect({
                 memberAlias: "cm",
                 actorAlias: "a",
                 userAlias: "u",
                 addressAlias: "author_primary_address",
                 prefix: "author_",
               }),
             )}
      FROM conversation_items ci
      LEFT JOIN conversation_members cm ON cm.id = ci.author_member_id
      LEFT JOIN actors a ON a.id = cm.actor_id
      LEFT JOIN users u ON u.id = cm.user_id
      ${sql.raw(buildPrimaryTransportAddressJoin("cm", "author_primary_address"))}
      WHERE ci.session_id = ${sessionId}
        AND ci.scope = 'private'
      ORDER BY ci.created_at ASC, ci.sequence ASC
    `.compile(db),
  );

  return loadItemsWithRelations(items.rows);
}

export async function getLastVisibleConversationItem(conversationId: string) {
  const items = await db.executeQuery(
    sql<any>`
      SELECT ci.*,
             ${sql.raw(
               buildEntitySelect({
                 memberAlias: "cm",
                 actorAlias: "a",
                 userAlias: "u",
                 addressAlias: "author_primary_address",
                 prefix: "author_",
               }),
             )}
      FROM conversation_items ci
      LEFT JOIN conversation_members cm ON cm.id = ci.author_member_id
      LEFT JOIN actors a ON a.id = cm.actor_id
      LEFT JOIN users u ON u.id = cm.user_id
      ${sql.raw(buildPrimaryTransportAddressJoin("cm", "author_primary_address"))}
      WHERE ci.conversation_id = ${conversationId}
        AND ci.scope = 'shared'
        AND ci.surface = 'visible'
      ORDER BY ci.sequence DESC
      LIMIT 1
    `.compile(db),
  );

  const [item] = await loadItemsWithRelations(items.rows);
  return item || null;
}

export async function listUserWorkspaceConversations(
  workspaceId: string,
  userId: string,
  workspaceMemberId?: string,
) {
  const result = await db.executeQuery(
    sql<any>`
      SELECT c.*,
             transport_account.transport_kind,
             cr.last_read_at,
             COALESCE(cr.read_watermark_sequence, 0) AS read_watermark_sequence,
             (
               SELECT COUNT(*)::int
               FROM conversation_items ci
               JOIN conversation_members cm_u
                 ON cm_u.conversation_id = c.id
                AND ${
                  workspaceMemberId
                    ? sql`cm_u.workspace_member_id = ${workspaceMemberId}`
                    : sql`cm_u.user_id = ${userId}`
                }
               WHERE ci.conversation_id = c.id
                 AND ci.scope = 'shared'
                 AND ci.surface = 'visible'
                 AND (
                   ci.subtype <> 'model_error_notice'
                   OR NOT EXISTS (
                     SELECT 1 FROM conversation_item_targets cit0
                     WHERE cit0.item_id = ci.id
                   )
                   OR EXISTS (
                     SELECT 1
                     FROM conversation_item_targets cit
                     JOIN conversation_members cm_target
                       ON cm_target.id = cit.target_member_id
                     WHERE cit.item_id = ci.id
                       AND ${
                         workspaceMemberId
                           ? sql`cm_target.workspace_member_id = ${workspaceMemberId}`
                           : sql`cm_target.user_id = ${userId}`
                       }
                   )
                 )
                 AND ci.sequence > COALESCE(cr.read_watermark_sequence, 0)
             ) AS unread_count
      FROM conversations c
      LEFT JOIN conversation_transport_bindings ctb
        ON ctb.conversation_id = c.id
      LEFT JOIN transport_accounts transport_account
        ON transport_account.id = ctb.transport_account_id
      JOIN conversation_members cm
        ON cm.conversation_id = c.id
       AND ${
         workspaceMemberId
           ? sql`cm.workspace_member_id = ${workspaceMemberId}`
           : sql`cm.user_id = ${userId}`
       }
       AND cm.state = 'active'
      LEFT JOIN conversation_user_states cr
        ON cr.conversation_id = c.id
       AND ${
         workspaceMemberId
           ? sql`cr.workspace_member_id = ${workspaceMemberId}`
           : sql`cr.user_id = ${userId}`
       }
      WHERE EXISTS (
        SELECT 1
        FROM conversation_members cm_viewer
        WHERE cm_viewer.conversation_id = c.id
          AND cm_viewer.state = 'active'
          AND ${
            workspaceMemberId
              ? sql`cm_viewer.workspace_member_id = ${workspaceMemberId}`
              : sql`cm_viewer.user_id = ${userId}`
          }
      )
      ORDER BY c.updated_at DESC, c.created_at DESC
    `.compile(db),
  );

  return result.rows;
}
