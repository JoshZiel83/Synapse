import { query, transaction } from "../../infrastructure/database/index.js";
import {
  buildActorConversationContextId,
  diffAuthzRelationships,
  deleteRelation,
  flushAuthzOutboxEntries,
  queueAuthzRelationships,
  touchActorConversationContext,
  touchRelation,
} from "../../infrastructure/authz/index.js";
import { emitEvent } from "../../infrastructure/events/index.js";
import { getFileUrl } from "../../infrastructure/storage/index.js";
import { getFileUrlById } from "../files/service.js";
import {
  extractText,
  nowISO,
} from "@synapse/shared";
import { v4 as uuidv4 } from "uuid";
import {
  conversationItemRowToFeedItem,
  createConversationEvent,
  getConversationFeedItemById,
  createConversationItem,
  ensureConversationMember,
  getConversationMember,
  getLastVisibleConversationItem,
  getSharedVisibleConversationItems,
  getVisibleConversationItemsForMember,
  listConversationMembers,
  listUserWorkspaceConversations,
  markConversationRead as markConversationCursorRead,
} from "./service.js";
import { activateConversationParticipant } from "./participant-activation.js";
import {
  buildNormalizedMessageContent,
  itemPartsToCanonicalContentBlocks,
} from "./message-content.js";
import {
  createSession,
  getSession,
  updateSessionStatus,
} from "../session/service.js";
import {
  enqueueSessionWakeup,
  publishSessionRuntime,
  removeSessionRuntime,
} from "../session/runtime.js";
import { authorizePermission, type AccessSubject } from "../access/service.js";
import {
  getConversationTransportBinding,
  getPrimaryTransportAddressForParticipant,
  getReachableTransportAddressForParticipant,
  queueConversationTransportProjection,
} from "../im/service.js";

type ConversationGrantPermission =
  | "send"
  | "moderate"
  | "manage"
  | "manage_members"
  | "attach_resources";

type ConversationGrantRow = {
  id?: string;
  conversation_id?: string;
  workspace_id: string;
  permission: ConversationGrantPermission;
  subject_type: "user" | "actor";
  user_id: string | null;
  actor_id: string | null;
  status: "active" | "revoked";
  granted_by?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | string | null;
  created_at?: string;
  revoked_at?: string | null;
};

function normalizeConversationRow(row: any) {
  if (!row) return null;
  return {
    ...row,
    conversation_id: row.id,
    avatar_url:
      row.avatar_url || avatarUrlFromConversationMetadata(row.metadata),
  };
}

function parseJson(value: unknown) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value || {};
}

function parseConversationMetadata(value: unknown): Record<string, unknown> {
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object"
    ? (parsed as Record<string, unknown>)
    : {};
}

function avatarUrlFromConversationMetadata(value: unknown): string | undefined {
  const metadata = parseConversationMetadata(value);
  const avatarFileId =
    typeof metadata.avatarFileId === "string" && metadata.avatarFileId.trim()
      ? metadata.avatarFileId.trim()
      : null;
  return avatarFileId ? getFileUrlById(avatarFileId) : undefined;
}

async function loadActorJoinVersionRefs(actorIds: string[]) {
  const refs = new Map<string, string>();
  if (actorIds.length === 0) {
    return refs;
  }

  const result = await query(
    `SELECT a.id, current_version.id AS actor_version_id
     FROM actors a
     JOIN actor_versions current_version
       ON current_version.actor_id = a.id
      AND current_version.version = a.current_version
     WHERE a.id = ANY($1::uuid[])`,
    [actorIds],
  );

  for (const row of result.rows) {
    refs.set(row.id as string, row.actor_version_id as string);
  }

  return refs;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function buildWakeupSummary(sourceName: string | undefined, content: string) {
  const normalized = content.replace(/\s+/g, " ").trim();
  const preview =
    normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
  if (sourceName && preview) return `${sourceName}: ${preview}`;
  if (sourceName) return `${sourceName} sent a message`;
  return preview || "New message";
}

async function resolveWorkspaceImageFile(workspaceId: string, fileId: string) {
  const result = await query(
    `SELECT id, stored_name, mime_type
     FROM files
     WHERE id = $1
       AND workspace_id = $2
     LIMIT 1`,
    [fileId, workspaceId],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("Avatar file not found in this workspace");
  }
  if (
    typeof row.mime_type !== "string" ||
    !row.mime_type.startsWith("image/")
  ) {
    throw new Error("Avatar file must be an image");
  }

  return {
    fileId: row.id as string,
  };
}

function mapConversationMemberPayload(row: any) {
  if (row.actor_id) {
    return stripUndefined({
      memberId: row.id as string,
      type: "actor" as const,
      actorId: row.actor_id as string,
      name: (row.actor_name as string) || "Unknown",
      title: (row.actor_title as string) || undefined,
      role: (row.actor_role as string) || "specialist",
      emoji: (row.actor_avatar_emoji as string) || undefined,
      avatarUrl: row.actor_avatar_stored_name
        ? getFileUrl(row.actor_avatar_stored_name as string)
        : undefined,
      state: row.state as string,
      sessionStatus: (row.session_status as string) || undefined,
    });
  }

  return stripUndefined({
    memberId: row.id as string,
    type: "user" as const,
    userId: row.user_id as string,
    name: (row.user_name as string) || "User",
    avatarUrl: row.user_avatar_file_id
      ? getFileUrlById(row.user_avatar_file_id as string)
      : undefined,
    state: row.state as string,
  });
}

function conversationGrantRelation(permission: ConversationGrantPermission) {
  switch (permission) {
    case "send":
      return "sender";
    case "moderate":
      return "moderator";
    case "manage":
      return "manager";
    case "manage_members":
      return "member_manager";
    case "attach_resources":
      return "resource_attacher";
    default:
      return null;
  }
}

function buildConversationGrantRelations(
  conversationId: string,
  grants: ConversationGrantRow[],
) {
  return grants
    .filter((grant) => grant.status === "active")
    .flatMap((grant) => {
      const relation = conversationGrantRelation(grant.permission);
      if (!relation) return [];
      if (grant.subject_type === "user" && grant.user_id) {
        return [
          touchRelation(
            "conversation",
            conversationId,
            relation,
            "user",
            grant.user_id,
          ),
        ];
      }
      if (grant.subject_type === "actor" && grant.actor_id) {
        return [
          touchRelation(
            "conversation",
            conversationId,
            relation,
            "actor",
            grant.actor_id,
          ),
        ];
      }
      return [];
    });
}

function mapConversationGrant(
  row: ConversationGrantRow & {
    id: string;
    conversation_id: string;
    created_at: string;
    revoked_at: string | null;
  },
) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    workspaceId: row.workspace_id,
    permission: row.permission,
    subjectType: row.subject_type,
    userId: row.user_id || undefined,
    actorId: row.actor_id || undefined,
    status: row.status,
    grantedBy: row.granted_by || undefined,
    reason: row.reason || undefined,
    metadata: parseJson(row.metadata),
    createdAt: row.created_at,
    revokedAt: row.revoked_at || undefined,
  };
}

function buildTextContentFromParts(parts: any[]) {
  const text = extractText(itemPartsToCanonicalContentBlocks(parts || []));

  if (text) return text;

  const jsonParts = parts
    .filter((part) => part.part_type === "json")
    .map((part) => JSON.stringify(part.json_value));
  return jsonParts.join("\n");
}

async function emitFeedItemCreated(workspaceId: string, itemId: string) {
  const item = await getConversationFeedItemById(itemId);
  if (!item || item.workspaceSequence === undefined) return;

  await emitEvent({
    type: "feed.item.created",
    workspaceId,
    payload: {
      workspaceSequence: item.workspaceSequence,
      item,
    },
    timestamp: nowISO(),
  });
}

async function emitConversationUpdated(params: {
  workspaceId: string;
  conversationId: string;
  action: "created" | "profile_updated" | "cancelled";
  title?: string | null;
  avatarUrl?: string | null;
}) {
  await emitEvent({
    type: "conversation.updated",
    workspaceId: params.workspaceId,
    payload: {
      conversationId: params.conversationId,
      action: params.action,
      title: params.title,
      avatarUrl: params.avatarUrl,
    },
    timestamp: nowISO(),
  });
}

async function findFeedItemByClientMessageId(params: {
  conversationId: string;
  authorMemberId: string;
  clientMessageId: string;
}) {
  const result = await query(
    `SELECT id
     FROM conversation_items
     WHERE conversation_id = $1
       AND author_member_id = $2
       AND client_message_id = $3
     LIMIT 1`,
    [params.conversationId, params.authorMemberId, params.clientMessageId],
  );
  const itemId = result.rows[0]?.id as string | undefined;
  return itemId ? getConversationFeedItemById(itemId) : null;
}

async function getLatestActorSession(conversationId: string, actorId: string) {
  const result = await query(
    `SELECT *
     FROM sessions
     WHERE conversation_id = $1 AND actor_id = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [conversationId, actorId],
  );
  return result.rows[0] ?? null;
}

async function ensureActorSession(params: {
  conversationId: string;
  workspaceId?: string;
  actorId: string;
  trigger: string;
}) {
  const existing = await getLatestActorSession(
    params.conversationId,
    params.actorId,
  );
  if (existing) return existing;

  let workspaceId = params.workspaceId;
  if (!workspaceId) {
    const actorResult = await query(
      `SELECT workspace_id
       FROM actors
       WHERE id = $1
       LIMIT 1`,
      [params.actorId],
    );
    workspaceId = actorResult.rows[0]?.workspace_id as string | undefined;
  }
  if (!workspaceId) {
    throw new Error(`Actor ${params.actorId} workspace not found`);
  }

  return createSession({
    workspaceId,
    actorId: params.actorId,
    conversationId: params.conversationId,
    channelType: "web",
    trigger: params.trigger,
    metadata: { lane: "conversation" },
  });
}

async function hydrateMembershipInitiator(params: {
  conversationId: string;
  initiator?: {
    memberType: "actor" | "user";
    participantId?: string;
    memberId?: string;
    actorId?: string;
    userId?: string;
    name?: string;
  };
}) {
  if (!params.initiator) return undefined;

  let memberId = params.initiator.memberId;
  let name = params.initiator.name;

  if (!memberId) {
    const member = await getConversationMember({
      conversationId: params.conversationId,
      actorId: params.initiator.actorId,
      userId: params.initiator.userId,
    });
    memberId = member?.id;
  }

  if (!name) {
    if (params.initiator.actorId) {
      const actorResult = await query(
        `SELECT name
         FROM actors
         WHERE id = $1
         LIMIT 1`,
        [params.initiator.actorId],
      );
      name = (actorResult.rows[0]?.name as string | undefined) || undefined;
    } else if (params.initiator.userId) {
      const userResult = await query(
        `SELECT name
         FROM users
         WHERE id = $1
         LIMIT 1`,
        [params.initiator.userId],
      );
      name = (userResult.rows[0]?.name as string | undefined) || undefined;
    }
  }

  return {
    ...params.initiator,
    participantId: memberId,
    memberId,
    name,
  };
}

async function recordMembershipEvent(params: {
  workspaceId?: string;
  conversationId: string;
  subtype: "member_joined" | "member_kicked" | "member_left";
  batchId: string;
  authorMemberId?: string;
  initiator?: {
    memberType: "actor" | "user";
    participantId?: string;
    memberId?: string;
    actorId?: string;
    userId?: string;
    name?: string;
  };
  members: Array<{
    participantId: string;
    memberId: string;
    memberType: "actor" | "user";
    actorId?: string;
    userId?: string;
    name: string;
    title?: string;
  }>;
}) {
  const initiator = await hydrateMembershipInitiator({
    conversationId: params.conversationId,
    initiator: params.initiator,
  });
  const created = await createConversationEvent({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    eventType: params.subtype,
    timelinePolicy: "all_members",
    contextPolicy: "shared",
    authorMemberId: params.authorMemberId || initiator?.memberId,
    metadata: {
      batchId: params.batchId,
    },
    eventPayload: {
      batchId: params.batchId,
      initiator: initiator
        ? {
            participantId: initiator.participantId || initiator.memberId,
            memberId: initiator.memberId,
            memberType: initiator.memberType,
            actorId: initiator.actorId,
            userId: initiator.userId,
            name: initiator.name,
          }
        : undefined,
      members: params.members.map((member) => ({
        participantId: member.participantId || member.memberId,
        memberId: member.memberId,
        memberType: member.memberType,
        actorId: member.actorId,
        userId: member.userId,
        name: member.name,
        title: member.title,
      })),
    },
  });

  if (params.workspaceId) {
    await emitFeedItemCreated(params.workspaceId, created.item.id);
  }
  return created;
}

async function resolveMemberTargets(params: {
  conversationId: string;
  members?: any[];
  targetParticipantIds?: string[];
  targetActorIds?: string[];
  targetUserIds?: string[];
}) {
  const members =
    params.members || (await listConversationMembers(params.conversationId));
  const participantIds = new Set(params.targetParticipantIds || []);
  if (participantIds.size > 0) {
    return members
      .filter(
        (member) => member.state === "active" && participantIds.has(member.id),
      )
      .map((member) => member.id as string);
  }

  const actorIds = new Set(params.targetActorIds || []);
  const userIds = new Set(params.targetUserIds || []);
  const targetMemberIds: string[] = [];

  for (const member of members) {
    if (member.state !== "active") continue;
    if (member.actor_id && actorIds.has(member.actor_id)) {
      targetMemberIds.push(member.id);
    }
    if (member.user_id && userIds.has(member.user_id)) {
      targetMemberIds.push(member.id);
    }
  }

  return targetMemberIds;
}

function getActorIdsFromTargetMembers(params: {
  members: any[];
  targetMemberIds: string[];
}) {
  const targetMemberIdSet = new Set(params.targetMemberIds);
  return Array.from(
    new Set(
      params.members
        .filter(
          (member) =>
            member.state === "active" &&
            member.actor_id &&
            targetMemberIdSet.has(member.id),
        )
        .map((member) => member.actor_id as string),
    ),
  );
}

function getAutomaticWakeActorIds(params: {
  members: any[];
  senderType: "user" | "actor";
  senderUserId?: string;
  hasExplicitTargets: boolean;
}) {
  if (
    params.senderType !== "user" ||
    !params.senderUserId ||
    params.hasExplicitTargets
  ) {
    return [];
  }

  const activeActors = params.members.filter(
    (member) => member.state === "active" && member.actor_id,
  );
  const activeUsers = params.members.filter(
    (member) => member.state === "active" && member.user_id,
  );

  if (activeActors.length !== 1 || activeUsers.length !== 1) {
    return [];
  }

  if (activeUsers[0]?.user_id !== params.senderUserId) {
    return [];
  }

  return [activeActors[0]!.actor_id as string];
}

function buildSenderSubject(params: {
  senderType: "user" | "actor";
  senderUserId?: string;
  senderActorId?: string;
}): AccessSubject | null {
  if (params.senderType === "actor" && params.senderActorId) {
    return { type: "actor" as const, id: params.senderActorId };
  }
  if (params.senderType === "user" && params.senderUserId) {
    return { type: "user" as const, id: params.senderUserId };
  }
  return null;
}

async function requireConversationSendPermission(params: {
  conversationId: string;
  senderType: "user" | "actor";
  senderUserId?: string;
  senderActorId?: string;
}) {
  const subject = buildSenderSubject(params);
  if (!subject) {
    throw new Error("Unable to resolve sender subject");
  }

  const allowed = await authorizePermission({
    subject,
    resourceType: "conversation",
    resourceId: params.conversationId,
    permission: "send",
  });

  if (!allowed) {
    throw new Error(
      "Sender is not allowed to send messages to this conversation",
    );
  }
}

async function filterAllowedTargetActorIds(params: {
  conversationId: string;
  senderType: "user" | "actor";
  senderUserId?: string;
  senderActorId?: string;
  targetActorIds: string[];
  explicit: boolean;
}) {
  if (params.targetActorIds.length === 0) {
    return params.targetActorIds;
  }

  const subject = buildSenderSubject(params);
  if (!subject) {
    throw new Error("Unable to resolve sender subject");
  }

  const checks = await Promise.all(
    params.targetActorIds.map(async (actorId) => ({
      actorId,
      allowed: await authorizePermission({
        subject,
        resourceType: "actor",
        resourceId: actorId,
        permission: "receive_message",
      }),
    })),
  );

  const allowedActorIds = checks
    .filter((item) => item.allowed)
    .map((item) => item.actorId);
  if (
    params.explicit &&
    allowedActorIds.length !== params.targetActorIds.length
  ) {
    throw new Error(
      "One or more target actors are not allowed to receive messages from this sender",
    );
  }

  return allowedActorIds;
}

function senderTypeFromItem(item: any): "user" | "actor" | "system" {
  if (
    item.role === "system" ||
    item.author_member_type === "system" ||
    item.item_type === "event"
  ) {
    return "system";
  }
  if (item.author_member_type === "actor" || item.role === "assistant") {
    return "actor";
  }
  return "user";
}

async function flushQueuedAuthzEntries(entryIds: string[], source: string) {
  if (entryIds.length === 0) return;

  try {
    await flushAuthzOutboxEntries(entryIds);
  } catch (error) {
    console.error(
      `[authz] Failed to flush ${source} relationship updates:`,
      error,
    );
  }
}

// ============ Conversation CRUD ============

export async function createThread(params: {
  workspaceId?: string;
  domain?: "workspace" | "social";
  kind: "group" | "private" | "virtual";
  createdBy: string;
  title?: string;
  actorIds?: string[];
  userIds?: string[];
  initialMessage?: string;
  initialContentBlocks?: import("@synapse/shared").CanonicalContentBlock[];
  targetActorIds?: string[];
  includeCreatorMember?: boolean;
}): Promise<{ conversation: any; members: any[]; message: any }> {
  const {
    workspaceId,
    domain = "workspace",
    kind,
    createdBy,
    title,
    actorIds: rawActorIds = [],
    userIds: rawUserIds = [],
    initialMessage,
    initialContentBlocks,
    targetActorIds = [],
    includeCreatorMember = true,
  } = params;
  const actorIds = Array.from(new Set(rawActorIds.filter(Boolean)));
  const userIds = Array.from(
    new Set(rawUserIds.filter((userId) => Boolean(userId) && userId !== createdBy)),
  );
  const participantUserIds = includeCreatorMember
    ? Array.from(new Set([createdBy, ...userIds]))
    : userIds;
  const participantCount = actorIds.length + participantUserIds.length;

  if (domain === "workspace" && !workspaceId) {
    throw new Error("workspaceId is required for workspace conversations");
  }
  if (kind === "private" && participantCount !== 2) {
    throw new Error("Private thread must have exactly two active members");
  }
  if (kind === "group" && participantCount < 2) {
    throw new Error("Group thread must have at least two active members");
  }
  if (kind === "virtual" && participantCount !== 0) {
    throw new Error("Virtual conversations cannot be created with active members");
  }

  const actorIdSet = new Set(actorIds);
  const initialTargetActorIds = Array.from(
    new Set(
      targetActorIds.filter(
        (actorId) => Boolean(actorId) && actorIdSet.has(actorId),
      ),
    ),
  );
  const conversationId = uuidv4();
  const batchId = uuidv4();
  const actorJoinVersionRefs = await loadActorJoinVersionRefs(actorIds);

  const result = await transaction(async (client) => {
    const actorRows =
      actorIds.length > 0
        ? (
            await client.query(
              `SELECT id, name, title, workspace_id FROM actors WHERE id = ANY($1::uuid[])`,
              [actorIds],
            )
          ).rows
        : [];
    if (actorRows.length !== actorIds.length) {
      throw new Error("One or more actors were not found");
    }
    if (
      domain === "workspace" &&
      actorRows.some((row: any) => row.workspace_id !== workspaceId)
    ) {
      throw new Error("Workspace thread actors must belong to the current workspace");
    }

    const userRows =
      participantUserIds.length > 0
        ? (
            await client.query(
              `SELECT u.id,
                      u.name,
                      wm.user_id AS workspace_member_user_id
               FROM users u
               LEFT JOIN workspace_members wm
                 ON wm.user_id = u.id
                AND wm.workspace_id = $1
               WHERE u.id = ANY($2::uuid[])`,
              [workspaceId || null, participantUserIds],
            )
          ).rows
        : [];
    if (userRows.length !== participantUserIds.length) {
      throw new Error("One or more users were not found");
    }
    if (
      domain === "workspace" &&
      userRows.some((row: any) => !row.workspace_member_user_id)
    ) {
      throw new Error("Workspace thread users must be members of the current workspace");
    }

    const actorMap = new Map<string, any>(
      actorRows.map((row: any) => [row.id, row]),
    );
    const userMap = new Map<string, any>(
      userRows.map((row: any) => [row.id, row]),
    );
    const fallbackTitle =
      title?.trim() ||
      (kind === "group"
        ? userRows
            .map((row: any) => row.name)
            .filter(Boolean)
            .join(", ") ||
          actorRows
            .map((row: any) => row.name)
            .filter(Boolean)
            .join(", ") ||
          "Untitled conversation"
        : null);

    const conversationResult = await client.query(
      `INSERT INTO conversations (id, workspace_id, domain, kind, title, created_by, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, NOW(), NOW())
       RETURNING *`,
      [
        conversationId,
        domain === "workspace" ? workspaceId : null,
        domain,
        kind,
        fallbackTitle,
        createdBy,
      ],
    );
    const conversation = normalizeConversationRow(conversationResult.rows[0]);

    const members: any[] = [];
    const joinedMembers: Array<{
      participantId: string;
      memberId: string;
      memberType: "actor" | "user";
      actorId?: string;
      userId?: string;
      name: string;
      title?: string;
    }> = [];

    for (const userId of participantUserIds) {
      const userMemberId = uuidv4();
      await client.query(
        `INSERT INTO conversation_members
           (id, conversation_id, member_type, user_id, state, metadata, joined_at)
         VALUES ($1, $2, 'user', $3, 'active', '{}'::jsonb, NOW())`,
        [userMemberId, conversationId, userId],
      );

      const userInfo = userMap.get(userId);
      joinedMembers.push({
        participantId: userMemberId,
        memberId: userMemberId,
        memberType: "user" as const,
        userId,
        name: userInfo?.name || "User",
      });
    }

    for (const actorId of actorIds) {
      const actorInfo = actorMap.get(actorId);
      const sessionId = uuidv4();
      await client.query(
        `INSERT INTO sessions
           (id, workspace_id, actor_id, conversation_id, channel_type, trigger, status, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'web', 'user_message', 'idle', '{}'::jsonb, NOW(), NOW())`,
        [sessionId, actorInfo.workspace_id, actorId, conversationId],
      );

      const memberId = uuidv4();
      await client.query(
        `INSERT INTO conversation_members
           (id, conversation_id, member_type, actor_id, actor_join_version_id, state, metadata, joined_at)
         VALUES ($1, $2, 'actor', $3, $4, 'active', '{}'::jsonb, NOW())`,
        [memberId, conversationId, actorId, actorJoinVersionRefs.get(actorId) || null],
      );
      members.push({ id: memberId, actorId, sessionId });

      joinedMembers.push({
        participantId: memberId,
        memberId,
        memberType: "actor",
        actorId,
        name: actorInfo?.name || "Unknown",
        title: actorInfo?.title,
      });
    }

    const authzEntryIds = await queueAuthzRelationships(
      client,
      [
        ...(domain === "workspace" && workspaceId
          ? [
              touchRelation(
                "conversation",
                conversationId,
                "workspace",
                "workspace",
                workspaceId,
              ),
            ]
          : []),
        touchRelation("conversation", conversationId, "admin", "user", createdBy),
        ...participantUserIds.map((userId) =>
          touchRelation("conversation", conversationId, "participant", "user", userId),
        ),
        ...actorIds.flatMap((actorId) => [
          touchRelation(
            "conversation",
            conversationId,
            "participant",
            "actor",
            actorId,
          ),
          ...touchActorConversationContext(actorId, conversationId),
        ]),
      ],
      {
        source: "conversation.create",
        workspaceId: workspaceId || null,
        conversationId,
        createdBy,
        domain,
        kind,
      },
    );

    return {
      conversation,
      members,
      joinedMembers,
      creatorName: userMap.get(createdBy)?.name || "User",
      authzEntryIds,
    };
  });

  await flushQueuedAuthzEntries(result.authzEntryIds, "conversation.create");

  if (result.joinedMembers.length > 0) {
    const creatorMember = result.joinedMembers.find(
      (member) => member.memberType === "user" && member.userId === createdBy,
    );
    await recordMembershipEvent({
      workspaceId: domain === "workspace" ? workspaceId : undefined,
      conversationId: conversationId,
      subtype: "member_joined",
      batchId,
      authorMemberId:
        creatorMember?.memberId || result.joinedMembers[0]?.memberId,
      initiator: creatorMember
        ? {
            memberType: "user",
            participantId: creatorMember.memberId,
            memberId: creatorMember.memberId,
            userId: createdBy,
            name: result.creatorName,
          }
        : undefined,
      members: result.joinedMembers,
    });
  }

  if (
    initialTargetActorIds.length > 0 &&
    (initialMessage ||
      (initialContentBlocks && initialContentBlocks.length > 0))
  ) {
    await sendConversationMessage({
      conversationId,
      senderType: "user",
      senderUserId: createdBy,
      content: initialMessage || "",
      contentBlocks: initialContentBlocks,
      targetActorIds: initialTargetActorIds,
    });
  }

  for (const member of result.members) {
    const session = await getSession(member.sessionId);
    if (session?.workspace_id) {
      await publishSessionRuntime(session.workspace_id, member.sessionId);
    }
  }

  if (domain === "workspace" && workspaceId) {
    await emitConversationUpdated({
      workspaceId,
      conversationId: conversationId,
      action: "created",
    });
  }

  return {
    conversation: result.conversation,
    members: result.members,
    message: null,
  };
}

export async function getConversation(conversationId: string): Promise<any | null> {
  const result = await query(
    `SELECT * FROM conversations WHERE id = $1`,
    [conversationId],
  );
  return normalizeConversationRow(result.rows[0] ?? null);
}

export async function updateConversationProfile(params: {
  conversationId: string;
  workspaceId: string;
  updatedBy: string;
  title?: string;
  avatarFileId?: string | null;
}) {
  const conversation = await getConversation(params.conversationId);
  if (!conversation || conversation.workspace_id !== params.workspaceId) {
    throw new Error("Conversation not found");
  }

  const currentMetadata = parseConversationMetadata(conversation.metadata);
  const nextMetadata = { ...currentMetadata };

  if (params.avatarFileId !== undefined) {
    if (params.avatarFileId === null) {
      delete nextMetadata.avatarFileId;
      delete nextMetadata.avatarUrl;
    } else {
      const file = await resolveWorkspaceImageFile(
        params.workspaceId,
        params.avatarFileId,
      );
      nextMetadata.avatarFileId = file.fileId;
      delete nextMetadata.avatarUrl;
    }
  }

  const title =
    typeof params.title === "string" ? params.title.trim() : undefined;
  const nextTitle =
    title === undefined ? conversation.title : title || conversation.title;

  const result = await query(
    `UPDATE conversations
     SET title = $2,
         metadata = $3::jsonb,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [params.conversationId, nextTitle, JSON.stringify(nextMetadata)],
  );

  const updated = normalizeConversationRow(result.rows[0]);

  await emitConversationUpdated({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    action: "profile_updated",
    title: updated.title,
    avatarUrl: updated.avatar_url || null,
  });

  return updated;
}

export async function getConversationsByWorkspace(
  workspaceId: string,
  userId: string,
  conversationIds?: string[],
): Promise<any[]> {
  const conversations = conversationIds
    ? conversationIds.length > 0
      ? (
	          await query(
            `SELECT c.*,
                  transport_account.transport_kind,
                  cr.last_read_at,
                  COALESCE(cr.last_read_sequence, 0) AS last_read_sequence,
                  (
                    SELECT COUNT(*)::int
                    FROM conversation_items ci
                    JOIN conversation_members cm_u
                      ON cm_u.conversation_id = c.id
                     AND cm_u.user_id = $2
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
                            AND cm_target.user_id = $2
                        )
                      )
                      AND ci.sequence > COALESCE(cr.last_read_sequence, 0)
                  ) AS unread_count
           FROM conversations c
           LEFT JOIN conversation_transport_bindings ctb
             ON ctb.conversation_id = c.id
	           LEFT JOIN transport_accounts transport_account
	             ON transport_account.id = ctb.transport_account_id
	           LEFT JOIN conversation_reads cr ON cr.conversation_id = c.id AND cr.user_id = $2
	           WHERE c.workspace_id = $1
	             AND c.domain = 'workspace'
	             AND c.id = ANY($3::uuid[])
	           ORDER BY c.updated_at DESC, c.created_at DESC`,
            [
              workspaceId,
              userId,
	              conversationIds,
            ],
          )
        ).rows
      : []
    : await listUserWorkspaceConversations(workspaceId, userId);
  if (conversations.length === 0) return [];

  const resolvedConversationIds = conversations.map(
    (conversation: any) => conversation.id,
  );
  const activeCountsResult = await query(
    `SELECT conversation_id, COUNT(*)::int AS active_count
     FROM sessions
     WHERE conversation_id = ANY($1)
       AND status <> 'closed'
     GROUP BY conversation_id`,
    [resolvedConversationIds],
  );
  const activeCountMap = new Map<string, number>(
    activeCountsResult.rows.map((row: any) => [
      row.conversation_id,
      row.active_count,
    ]),
  );

  const lastItemsResult = await query(
    `SELECT DISTINCT ON (ci.conversation_id)
            ci.conversation_id,
            ci.id,
            ci.role,
            ci.item_type,
            ci.created_at,
            cm.member_type AS author_member_type,
            COALESCE(a.name, u.name, cm.display_name) AS author_name
     FROM conversation_items ci
     LEFT JOIN conversation_members cm ON cm.id = ci.author_member_id
     LEFT JOIN actors a ON a.id = cm.actor_id
     LEFT JOIN users u ON u.id = cm.user_id
     WHERE ci.conversation_id = ANY($1)
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
             AND cm_target.user_id = $2
         )
       )
     ORDER BY ci.conversation_id, ci.sequence DESC`,
    [resolvedConversationIds, userId],
  );

  const lastItemMap = new Map<string, any>(
    lastItemsResult.rows.map((row: any) => [row.conversation_id, row]),
  );
  const itemIds = lastItemsResult.rows.map((row: any) => row.id);
  const lastPartsResult =
    itemIds.length > 0
      ? await query(
          `SELECT cip.*
         FROM conversation_item_parts cip
         WHERE cip.item_id = ANY($1)
         ORDER BY cip.item_id, cip.ordinal ASC`,
          [itemIds],
        )
      : { rows: [] };
  const partsByItem = new Map<string, any[]>();
  for (const row of lastPartsResult.rows) {
    if (!partsByItem.has(row.item_id)) partsByItem.set(row.item_id, []);
    partsByItem.get(row.item_id)!.push(row);
  }

  return conversations.map((conversation: any) => {
    const lastItem = lastItemMap.get(conversation.id);
    const lastParts = lastItem ? partsByItem.get(lastItem.id) || [] : [];
    const senderType = lastItem
      ? senderTypeFromItem({
          ...lastItem,
          author_member_type: lastItem.author_member_type,
        })
      : null;

    return {
      ...normalizeConversationRow(conversation),
      last_message: lastItem ? buildTextContentFromParts(lastParts) : null,
      last_message_sender_type: senderType,
      last_message_sender_name: lastItem?.author_name || "System",
      last_message_at: lastItem?.created_at || null,
      unread_count: conversation.unread_count || 0,
      active_count: activeCountMap.get(conversation.id) || 0,
    };
  });
}

export async function getThreadsForUser(params: {
  userId: string;
  workspaceId?: string;
  domain?: "workspace" | "social";
}): Promise<any[]> {
  const queryParams: any[] = [params.userId];
  const filters: string[] = [];

  if (params.workspaceId) {
    const workspaceIdIndex = queryParams.push(params.workspaceId);
    if (params.domain === "workspace") {
      filters.push(
        `c.domain = 'workspace' AND c.workspace_id = $${workspaceIdIndex}`,
      );
    } else if (params.domain === "social") {
      filters.push(`c.domain = 'social'`);
    } else {
      filters.push(
        `(c.domain = 'social' OR (c.domain = 'workspace' AND c.workspace_id = $${workspaceIdIndex}))`,
      );
    }
  } else if (params.domain) {
    const domainIndex = queryParams.push(params.domain);
    filters.push(`c.domain = $${domainIndex}`);
  }

  const visibilityClause =
    filters.length > 0 ? `AND (${filters.join(" AND ")})` : "";

  const conversations = (
    await query(
      `SELECT c.*,
              transport_account.transport_kind,
              cr.last_read_at,
              COALESCE(cr.last_read_sequence, 0) AS last_read_sequence,
              (
                SELECT COUNT(*)::int
                FROM conversation_items ci
                JOIN conversation_members cm_u
                  ON cm_u.conversation_id = c.id
                 AND cm_u.user_id = $1
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
                        AND cm_target.user_id = $1
                    )
                  )
                  AND ci.sequence > COALESCE(cr.last_read_sequence, 0)
              ) AS unread_count
       FROM conversations c
       JOIN conversation_members cm
         ON cm.conversation_id = c.id
        AND cm.user_id = $1
        AND cm.state = 'active'
       LEFT JOIN conversation_transport_bindings ctb
         ON ctb.conversation_id = c.id
       LEFT JOIN transport_accounts transport_account
         ON transport_account.id = ctb.transport_account_id
       LEFT JOIN conversation_reads cr
         ON cr.conversation_id = c.id
        AND cr.user_id = $1
       WHERE 1 = 1
         ${visibilityClause}
       ORDER BY c.updated_at DESC, c.created_at DESC`,
      queryParams,
    )
  ).rows;

  if (conversations.length === 0) return [];

  const conversationIds = conversations.map((conversation: any) => conversation.id);
  const activeCountsResult = await query(
    `SELECT conversation_id, COUNT(*)::int AS active_count
     FROM sessions
     WHERE conversation_id = ANY($1::uuid[])
       AND status <> 'closed'
     GROUP BY conversation_id`,
    [conversationIds],
  );
  const activeCountMap = new Map<string, number>(
    activeCountsResult.rows.map((row: any) => [
      row.conversation_id,
      row.active_count,
    ]),
  );

  const lastItemsResult = await query(
    `SELECT DISTINCT ON (ci.conversation_id)
            ci.conversation_id,
            ci.id,
            ci.role,
            ci.item_type,
            ci.created_at,
            cm.member_type AS author_member_type,
            COALESCE(a.name, u.name, cm.display_name) AS author_name
     FROM conversation_items ci
     LEFT JOIN conversation_members cm ON cm.id = ci.author_member_id
     LEFT JOIN actors a ON a.id = cm.actor_id
     LEFT JOIN users u ON u.id = cm.user_id
     WHERE ci.conversation_id = ANY($1::uuid[])
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
             AND cm_target.user_id = $2
         )
       )
     ORDER BY ci.conversation_id, ci.sequence DESC`,
    [conversationIds, params.userId],
  );

  const lastItemMap = new Map<string, any>(
    lastItemsResult.rows.map((row: any) => [row.conversation_id, row]),
  );
  const itemIds = lastItemsResult.rows.map((row: any) => row.id);
  const lastPartsResult =
    itemIds.length > 0
      ? await query(
          `SELECT cip.*
           FROM conversation_item_parts cip
           WHERE cip.item_id = ANY($1::uuid[])
           ORDER BY cip.item_id, cip.ordinal ASC`,
          [itemIds],
        )
      : { rows: [] };
  const partsByItem = new Map<string, any[]>();
  for (const row of lastPartsResult.rows) {
    if (!partsByItem.has(row.item_id)) partsByItem.set(row.item_id, []);
    partsByItem.get(row.item_id)!.push(row);
  }

  return conversations.map((conversation: any) => {
    const lastItem = lastItemMap.get(conversation.id);
    const lastParts = lastItem ? partsByItem.get(lastItem.id) || [] : [];
    const senderType = lastItem
      ? senderTypeFromItem({
          ...lastItem,
          author_member_type: lastItem.author_member_type,
        })
      : null;

    return {
      ...normalizeConversationRow(conversation),
      last_message: lastItem ? buildTextContentFromParts(lastParts) : null,
      last_message_sender_type: senderType,
      last_message_sender_name: lastItem?.author_name || "System",
      last_message_at: lastItem?.created_at || null,
      unread_count: conversation.unread_count || 0,
      active_count: activeCountMap.get(conversation.id) || 0,
    };
  });
}

// ============ Member Management ============

export async function addActorToConversation(
  conversationId: string,
  actorId: string,
  _inviterActorName?: string,
  batchId?: string,
): Promise<{ member: any; session: any }> {
  const conversation = await getConversation(conversationId);
  if (!conversation) throw new Error("Conversation not found");
  const actorJoinVersionId = (await loadActorJoinVersionRefs([actorId])).get(actorId);

  const existing = await getConversationMember({
    conversationId: conversationId,
    actorId,
  });
  if (existing?.state === "active") {
    throw new Error("Actor already in conversation");
  }

  const actorResult = await query(
    `SELECT name, title, workspace_id FROM actors WHERE id = $1`,
    [actorId],
  );
  const actorInfo = actorResult.rows[0];
  const result = await transaction(async (client) => {
    const member = await ensureConversationMember({
      conversationId: conversationId,
      memberType: "actor",
      actorId,
      actorJoinVersionId,
    });
    const session = await createSession({
      workspaceId: actorInfo?.workspace_id || conversation.workspace_id,
      actorId,
      conversationId: conversationId,
      channelType: "web",
      trigger: "actor_invite",
      metadata: { lane: "conversation" },
    });

    const authzEntryIds = await queueAuthzRelationships(
      client,
      [
        touchRelation("conversation", conversationId, "participant", "actor", actorId),
        ...touchActorConversationContext(actorId, conversationId),
      ],
      {
        source: "conversation.add_actor",
        conversationId,
        actorId,
      },
    );

    return { member, session, authzEntryIds };
  });

  await flushQueuedAuthzEntries(result.authzEntryIds, "conversation.add_actor");
  if (actorInfo?.workspace_id || conversation.workspace_id) {
    await publishSessionRuntime(
      actorInfo?.workspace_id || conversation.workspace_id,
      result.session.id,
    );
  }

  const eventBatchId = batchId || uuidv4();
  await recordMembershipEvent({
    workspaceId: conversation.workspace_id || undefined,
    conversationId: conversationId,
    subtype: "member_joined",
    batchId: eventBatchId,
    members: [
      {
        participantId: result.member.id,
        memberId: result.member.id,
        memberType: "actor",
        actorId,
        name: actorInfo?.name || "Unknown",
        title: actorInfo?.title,
      },
    ],
  });

  return {
    member: {
      id: result.member.id,
      conversationId,
      actorId,
      sessionId: result.session.id,
    },
    session: { id: result.session.id },
  };
}

export async function addMembersToConversation(params: {
  conversationId: string;
  workspaceId: string;
  actorIds?: string[];
  userIds?: string[];
  initiator?: {
    memberType: "actor" | "user";
    memberId?: string;
    actorId?: string;
    userId?: string;
    name?: string;
  };
}) {
  const actorIds = [...new Set((params.actorIds || []).filter(Boolean))];
  const userIds = [...new Set((params.userIds || []).filter(Boolean))];
  if (actorIds.length === 0 && userIds.length === 0) {
    throw new Error("At least one actor or user is required");
  }

  const conversation = await getConversation(params.conversationId);
  if (!conversation || conversation.workspace_id !== params.workspaceId) {
    throw new Error("Conversation not found");
  }

  const actorResult =
    actorIds.length > 0
      ? await query(
          `SELECT a.id,
                  a.name,
                  a.title,
                  a.role,
                  a.avatar_emoji,
                  avatar_file.stored_name AS avatar_stored_name
         FROM actors a
         LEFT JOIN files avatar_file ON avatar_file.id = a.avatar_file_id
         WHERE a.workspace_id = $1
           AND a.id = ANY($2)`,
          [params.workspaceId, actorIds],
        )
      : { rows: [] as any[] };
  const userResult =
    userIds.length > 0
      ? await query(
          `SELECT u.id, u.name, u.avatar_file_id
         FROM workspace_members wm
         JOIN users u ON u.id = wm.user_id
         WHERE wm.workspace_id = $1
           AND u.id = ANY($2)`,
          [params.workspaceId, userIds],
        )
      : { rows: [] as any[] };

  if (actorResult.rows.length !== actorIds.length) {
    throw new Error("One or more actors are not available in this workspace");
  }
  if (userResult.rows.length !== userIds.length) {
    throw new Error("One or more users are not members of this workspace");
  }

  const actorMap = new Map(
    actorResult.rows.map((row) => [row.id as string, row]),
  );
  const actorJoinVersionRefs = await loadActorJoinVersionRefs(actorIds);
  const userMap = new Map(
    userResult.rows.map((row) => [row.id as string, row]),
  );
  const batchId = uuidv4();

  const result = await transaction(async (client) => {
    const relationships = [];
    const addedMembers: any[] = [];
    const joinedMembers: Array<{
      participantId: string;
      memberId: string;
      memberType: "actor" | "user";
      actorId?: string;
      userId?: string;
      name: string;
      title?: string;
    }> = [];

    for (const actorId of actorIds) {
      const existing = await getConversationMember({
        conversationId: params.conversationId,
        actorId,
      });
      if (existing?.state === "active") continue;

      const member = await ensureConversationMember({
        conversationId: params.conversationId,
        memberType: "actor",
        actorId,
        actorJoinVersionId: actorJoinVersionRefs.get(actorId),
      });
      const session = await createSession({
        workspaceId: params.workspaceId,
        actorId,
        conversationId: params.conversationId,
        channelType: "web",
        trigger: "actor_invite",
        metadata: { lane: "conversation" },
      });

      const actorInfo = actorMap.get(actorId)!;
      relationships.push(
        touchRelation(
          "conversation",
          params.conversationId,
          "participant",
          "actor",
          actorId,
        ),
        ...touchActorConversationContext(actorId, params.conversationId),
      );
      addedMembers.push({
        memberId: member.id,
        type: "actor" as const,
        actorId,
        name: actorInfo.name || "Unknown",
        title: actorInfo.title || undefined,
        role: actorInfo.role || "specialist",
        emoji: actorInfo.avatar_emoji || undefined,
        avatarUrl: actorInfo.avatar_stored_name
          ? getFileUrl(actorInfo.avatar_stored_name)
          : undefined,
      });
      joinedMembers.push({
        participantId: member.id,
        memberId: member.id,
        memberType: "actor",
        actorId,
        name: actorInfo.name || "Unknown",
        title: actorInfo.title || undefined,
      });
    }

    for (const userId of userIds) {
      const existing = await getConversationMember({
        conversationId: params.conversationId,
        userId,
      });
      if (existing?.state === "active") continue;

      const member = await ensureConversationMember({
        conversationId: params.conversationId,
        memberType: "user",
        userId,
      });
      const userInfo = userMap.get(userId)!;
      relationships.push(
        touchRelation(
          "conversation",
          params.conversationId,
          "participant",
          "user",
          userId,
        ),
      );
      addedMembers.push({
        memberId: member.id,
        type: "user" as const,
        userId,
        name: userInfo.name || "User",
        avatarUrl: userInfo.avatar_file_id
          ? getFileUrlById(userInfo.avatar_file_id)
          : undefined,
      });
      joinedMembers.push({
        participantId: member.id,
        memberId: member.id,
        memberType: "user",
        userId,
        name: userInfo.name || "User",
      });
    }

    const authzEntryIds = await queueAuthzRelationships(client, relationships, {
      source: "conversation.add_members",
      conversationId: params.conversationId,
      actorIds,
      userIds,
    });

    return {
      addedMembers,
      joinedMembers,
      authzEntryIds,
    };
  });

  await flushQueuedAuthzEntries(result.authzEntryIds, "conversation.add_members");
  await Promise.all(
    result.addedMembers
      .filter((member: any) => member.type === "actor" && member.actorId)
      .map(async (member: any) => {
        const session = await getLatestActorSession(
          params.conversationId,
          member.actorId,
        );
        if (session) {
          await publishSessionRuntime(params.workspaceId, session.id);
        }
      }),
  );

  if (result.joinedMembers.length > 0) {
    const initiator = await hydrateMembershipInitiator({
      conversationId: params.conversationId,
      initiator: params.initiator,
    });
    await recordMembershipEvent({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      subtype: "member_joined",
      batchId,
      authorMemberId: initiator?.memberId,
      initiator,
      members: result.joinedMembers,
    });

  }

  return { members: result.addedMembers };
}

export async function removeActorFromConversation(
  conversationId: string,
  actorId: string,
): Promise<void> {
  const conversation = await getConversation(conversationId);
  if (!conversation) throw new Error("Conversation not found");

  const member = await getConversationMember({
    conversationId: conversationId,
    actorId,
  });
  if (!member) return;

  const { authzEntryIds, closedSessionIds } = await transaction(
    async (client) => {
      await client.query(
        `UPDATE conversation_members
       SET state = 'kicked', left_at = NOW()
       WHERE id = $1`,
        [member.id],
      );
      const closedSessions = await client.query(
        `UPDATE sessions
       SET status = 'closed', completed_at = NOW(), updated_at = NOW()
       WHERE conversation_id = $1 AND actor_id = $2 AND status <> 'closed'
       RETURNING id`,
        [conversationId, actorId],
      );

      return {
        closedSessionIds: closedSessions.rows.map(
          (row: any) => row.id as string,
        ),
        authzEntryIds: await queueAuthzRelationships(
          client,
          [
            deleteRelation(
              "conversation",
              conversationId,
              "participant",
              "actor",
              actorId,
            ),
            deleteRelation(
              "actor_conversation",
              buildActorConversationContextId(actorId, conversationId),
              "actor",
              "actor",
              actorId,
            ),
            deleteRelation(
              "actor_conversation",
              buildActorConversationContextId(actorId, conversationId),
              "conversation",
              "conversation",
              conversationId,
            ),
          ],
          {
            source: "conversation.remove_actor",
            conversationId,
            actorId,
          },
        ),
      };
    },
  );

  await flushQueuedAuthzEntries(authzEntryIds, "conversation.remove_actor");
  await Promise.all(
    closedSessionIds.map((sessionId: string) =>
      removeSessionRuntime(sessionId),
    ),
  );

  const actorResult = await query(
    "SELECT name, title FROM actors WHERE id = $1",
    [actorId],
  );
  const actorInfo = actorResult.rows[0];
  const eventBatchId = uuidv4();
  await recordMembershipEvent({
    workspaceId: conversation.workspace_id,
    conversationId: conversationId,
    subtype: "member_kicked",
    batchId: eventBatchId,
    members: [
      {
        participantId: member.id,
        memberId: member.id,
        memberType: "actor",
        actorId,
        name: actorInfo?.name || "Unknown",
        title: actorInfo?.title,
      },
    ],
  });

}

export async function getConversationMembers(
  conversationId: string,
  options?: { useProfileSnapshot?: boolean },
): Promise<any[]> {
  const actorNameExpr = options?.useProfileSnapshot
    ? "COALESCE(joined_version.name, a.name)"
    : "a.name";
  const actorTitleExpr = options?.useProfileSnapshot
    ? "COALESCE(joined_version.title, a.title)"
    : "a.title";
  const actorRoleExpr = options?.useProfileSnapshot
    ? "COALESCE(joined_version.role, a.role)"
    : "a.role";
  const actorCanRepresentExpr = options?.useProfileSnapshot
    ? "COALESCE(joined_version.can_represent_user, a.can_represent_user)"
    : "a.can_represent_user";
  const actorSpecialtiesExpr = options?.useProfileSnapshot
    ? "COALESCE(joined_version.specialties, a.specialties)"
    : "a.specialties";
  const actorConfigExpr = options?.useProfileSnapshot
    ? "COALESCE(joined_version.config, a.config)"
    : "a.config";
  const actorCurrentVersionExpr = options?.useProfileSnapshot
    ? "COALESCE(joined_version.version, a.current_version)"
    : "a.current_version";
  const actorDocVersionExpr = options?.useProfileSnapshot
    ? "COALESCE(cm.actor_join_version_id, current_version.id)"
    : "current_version.id";

  const result = await query(
    `SELECT cm.*,
            ${actorNameExpr} AS actor_name,
            ${actorTitleExpr} AS actor_title,
            ${actorRoleExpr} AS actor_role,
            COALESCE(
              (
                SELECT jsonb_agg(
                  jsonb_build_object(
                    'key', avd.doc_key,
                    'title', avd.title,
                    'visibility', avd.visibility,
                    'priority', avd.priority,
                    'content', avd.content_blocks
                  )
                  ORDER BY avd.priority DESC, avd.created_at ASC
                )
                FROM actor_version_docs avd
                WHERE avd.actor_version_id = ${actorDocVersionExpr}
              ),
              '[]'::jsonb
            ) AS actor_docs,
            ${actorCanRepresentExpr} AS actor_can_represent_user,
            ${actorSpecialtiesExpr} AS actor_specialties,
            ${actorConfigExpr} AS actor_config,
            ${actorCurrentVersionExpr} AS actor_current_version,
            a.avatar_emoji AS actor_avatar_emoji,
            actor_avatar_file.stored_name AS actor_avatar_stored_name,
            u.name AS user_name,
            u.avatar_file_id AS user_avatar_file_id,
            primary_address.id AS transport_address_id,
            primary_address.transport_kind AS transport_kind,
            primary_address.external_id AS transport_external_id,
            primary_address.display_name AS transport_display_name,
            primary_address.linked_user_id AS linked_user_id,
            linked_user.name AS linked_user_name,
            linked_user.avatar_file_id AS linked_user_avatar_file_id,
            ls.id AS session_id,
            ls.status AS session_status
     FROM conversation_members cm
     LEFT JOIN actors a ON a.id = cm.actor_id
     LEFT JOIN actor_versions current_version
       ON current_version.actor_id = a.id
      AND current_version.version = a.current_version
     LEFT JOIN actor_versions joined_version
       ON joined_version.id = cm.actor_join_version_id
     LEFT JOIN files actor_avatar_file ON actor_avatar_file.id = a.avatar_file_id
     LEFT JOIN users u ON u.id = cm.user_id
     LEFT JOIN LATERAL (
       SELECT ta.id,
              ta.transport_kind,
              ta.external_id,
              ta.user_id AS linked_user_id,
              COALESCE(ta.display_name, cm.display_name) AS display_name
       FROM conversation_participant_addresses cpa
       JOIN transport_addresses ta ON ta.id = cpa.transport_address_id
       WHERE cpa.conversation_member_id = cm.id
       ORDER BY cpa.is_primary DESC, cpa.created_at ASC
       LIMIT 1
     ) primary_address ON TRUE
     LEFT JOIN users linked_user ON linked_user.id = primary_address.linked_user_id
     LEFT JOIN LATERAL (
       SELECT s.id, s.status
       FROM sessions s
       WHERE s.conversation_id = cm.conversation_id
         AND s.actor_id = cm.actor_id
       ORDER BY s.created_at DESC
       LIMIT 1
     ) ls ON TRUE
     WHERE cm.conversation_id = $1
     ORDER BY cm.joined_at ASC`,
    [conversationId],
  );
  return result.rows.map((row: any) => ({
    ...row,
    conversation_id: conversationId,
  }));
}

// ============ Conversation Messages ============

export async function sendConversationMessage(params: {
  conversationId: string;
  senderType: "user" | "actor";
  senderUserId?: string;
  senderActorId?: string;
  senderSessionId?: string;
  clientMessageId?: string;
  targetParticipantIds?: string[];
  targetActorIds?: string[];
  targetUserIds?: string[];
  content: string;
  contentBlocks?: import("@synapse/shared").CanonicalContentBlock[];
  metadata?: Record<string, unknown>;
}): Promise<any> {
  const {
    conversationId,
    senderType,
    senderUserId,
    senderActorId,
    senderSessionId,
    clientMessageId,
  content,
  contentBlocks,
  metadata = {},
  } = params;
  const conversation = await getConversation(conversationId);
  if (!conversation) throw new Error("Conversation not found");

  await requireConversationSendPermission({
    conversationId: conversationId,
    senderType,
    senderUserId,
    senderActorId,
  });

  const requestedTargetParticipantIds = Array.isArray(
    params.targetParticipantIds,
  )
    ? Array.from(new Set(params.targetParticipantIds.filter(Boolean)))
    : [];
  const requestedTargetActorIds = Array.isArray(params.targetActorIds)
    ? Array.from(new Set(params.targetActorIds.filter(Boolean)))
    : [];
  const requestedTargetUserIds = Array.isArray(params.targetUserIds)
    ? Array.from(new Set(params.targetUserIds.filter(Boolean)))
    : [];
  const hasExplicitTargets =
    requestedTargetParticipantIds.length > 0 ||
    requestedTargetActorIds.length > 0 ||
    requestedTargetUserIds.length > 0;

  let senderName: string | undefined;
  if (senderActorId) {
    const actorResult = await query("SELECT name FROM actors WHERE id = $1", [
      senderActorId,
    ]);
    senderName = actorResult.rows[0]?.name;
  } else if (senderUserId) {
    const userResult = await query("SELECT name FROM users WHERE id = $1", [
      senderUserId,
    ]);
    senderName = userResult.rows[0]?.name;
  }

  const authorMember =
    senderType === "actor"
      ? (
          await activateConversationParticipant({
            workspaceId: conversation.workspace_id || undefined,
            conversationId: conversationId,
            memberType: "actor",
            actorId: senderActorId,
            actorJoinVersionId: senderActorId
              ? (await loadActorJoinVersionRefs([senderActorId])).get(senderActorId)
              : undefined,
            initiator: senderActorId
              ? {
                  memberType: "actor",
                  actorId: senderActorId,
                  name: senderName,
                }
              : undefined,
          })
        ).member
      : (
          await activateConversationParticipant({
            workspaceId: conversation.workspace_id || undefined,
            conversationId: conversationId,
            memberType: "user",
            userId: senderUserId,
            initiator: senderUserId
              ? {
                  memberType: "user",
                  userId: senderUserId,
                  name: senderName,
                }
              : undefined,
          })
        ).member;

  const members = await listConversationMembers(conversationId);
  const participantTargetMemberIds = await resolveMemberTargets({
    conversationId: conversationId,
    members,
    targetParticipantIds: requestedTargetParticipantIds,
    targetUserIds: requestedTargetUserIds,
  });
  const membersById = new Map(
    members.map((member: any) => [member.id as string, member]),
  );
  const requestedTargetActorIdsFromParticipantTargets =
    getActorIdsFromTargetMembers({
      members,
      targetMemberIds: participantTargetMemberIds,
    });
  const requestedExplicitActorIds = Array.from(
    new Set([
      ...requestedTargetActorIds,
      ...requestedTargetActorIdsFromParticipantTargets,
    ]),
  );
  const allowedExplicitActorIds = await filterAllowedTargetActorIds({
    conversationId: conversationId,
    senderType,
    senderUserId,
    senderActorId,
    targetActorIds: requestedExplicitActorIds,
    explicit: requestedExplicitActorIds.length > 0,
  });
  const actorTargetMemberIds =
    allowedExplicitActorIds.length > 0
      ? await resolveMemberTargets({
          conversationId: conversationId,
          members,
          targetActorIds: allowedExplicitActorIds,
        })
      : [];
  const requestedTargetMemberIds = Array.from(
    new Set([...participantTargetMemberIds, ...actorTargetMemberIds]),
  );
  const allowedTargetActorIdSet = new Set(allowedExplicitActorIds);
  const targetMemberIds = requestedTargetMemberIds.filter((targetMemberId) => {
    const member = membersById.get(targetMemberId);
    if (!member?.actor_id) return true;
    return allowedTargetActorIdSet.has(member.actor_id);
  });
  const actorIdsRepresentedByTargetMembers = getActorIdsFromTargetMembers({
    members,
    targetMemberIds,
  });
  const actorIdsRepresentedByTargetMemberSet = new Set(
    actorIdsRepresentedByTargetMembers,
  );
  const additionalTargetActorIds = allowedExplicitActorIds.filter(
    (actorId) => !actorIdsRepresentedByTargetMemberSet.has(actorId),
  );
  const transportBinding =
    conversation.workspace_id && targetMemberIds.length > 0
      ? await getConversationTransportBinding({
          workspaceId: conversation.workspace_id,
          conversationId: conversationId,
        })
      : null;
  let hasExplicitTransportTargets = false;
  if (transportBinding) {
    for (const targetMemberId of targetMemberIds) {
      const useAttachedAddressOnly =
        transportBinding.endpoint.endpointType === "group" ||
        (transportBinding.endpoint.endpointType === "direct" &&
          transportBinding.transportKind === "feishu");
      const reachableAddress = useAttachedAddressOnly
        ? await getPrimaryTransportAddressForParticipant({
            conversationMemberId: targetMemberId,
            transportAccountId: transportBinding.account.id,
          })
        : await getReachableTransportAddressForParticipant({
            conversationMemberId: targetMemberId,
            transportAccountId: transportBinding.account.id,
          });
      if (!reachableAddress?.external_id) continue;
      if (
        transportBinding.endpoint.endpointType === "direct" &&
        transportBinding.transportKind !== "feishu" &&
        reachableAddress.external_id !== transportBinding.endpoint.externalId
      ) {
        continue;
      }
      hasExplicitTransportTargets = true;
      break;
    }
  }
  const explicitWakeActorIds = Array.from(
    new Set([
      ...allowedExplicitActorIds,
      ...actorIdsRepresentedByTargetMembers,
    ]),
  );
  const automaticWakeCandidateIds = getAutomaticWakeActorIds({
    members,
    senderType,
    senderUserId,
    hasExplicitTargets,
  });
  const automaticWakeActorIds = await filterAllowedTargetActorIds({
    conversationId: conversationId,
    senderType,
    senderUserId,
    senderActorId,
    targetActorIds: automaticWakeCandidateIds,
    explicit: false,
  });
  const wakeActorIds = Array.from(
    new Set([...explicitWakeActorIds, ...automaticWakeActorIds]),
  );
  const normalizedMessage = await buildNormalizedMessageContent({
    content,
    contentBlocks,
    metadata:
      additionalTargetActorIds.length > 0
        ? {
            ...metadata,
            targetActorIds: additionalTargetActorIds,
          }
        : metadata,
  });
  let item: any;
  try {
    item = await createConversationItem({
      workspaceId: conversation.workspace_id || undefined,
      conversationId: conversationId,
      sessionId: senderSessionId,
      clientMessageId,
      scope: "shared",
      surface: "visible",
      itemType: "message",
      subtype: "chat",
      role: senderType === "actor" ? "assistant" : "user",
      authorMemberId: authorMember?.id,
      metadata: normalizedMessage.normalizedMetadata,
      parts: normalizedMessage.parts,
      targetMemberIds,
    });
  } catch (error: any) {
    if (clientMessageId && authorMember?.id && error?.code === "23505") {
      const existing = await findFeedItemByClientMessageId({
        conversationId: conversationId,
        authorMemberId: authorMember.id,
        clientMessageId,
      });
      if (existing) {
        return { item: existing };
      }
    }
    throw error;
  }

  if (conversation.workspace_id) {
    await emitFeedItemCreated(conversation.workspace_id, item.id);
  }
  if (conversation.workspace_id && hasExplicitTransportTargets) {
    await queueConversationTransportProjection({
      workspaceId: conversation.workspace_id,
      conversationId: conversationId,
      itemId: item.id,
      direction: "outbound",
      metadata: {
        senderType,
        senderActorId,
        senderUserId,
        targetMemberIds,
      },
    }).catch((err) => {
      console.error(
        `Failed to queue transport projection for item ${item.id}:`,
        err.message,
      );
    });
  }

  const wakeupSourceType =
    senderType === "actor"
      ? ("actor_message" as const)
      : ("user_message" as const);
  const wakeupSummary = buildWakeupSummary(
    senderName,
    normalizedMessage.normalizedContent,
  );
  for (const targetActorId of wakeActorIds) {
    const isAutomaticWake = automaticWakeActorIds.includes(targetActorId);
    await wakeActor({
      conversationId: conversationId,
      actorId: targetActorId,
      sourceType: wakeupSourceType,
      sourceItemId: item.id,
      sourceSessionId: senderSessionId,
      sourceMemberType: senderType,
      sourceMemberId: senderType === "actor" ? senderActorId : senderUserId,
      sourceName: senderName,
      summary: wakeupSummary,
      metadata: isAutomaticWake
        ? { delivery: "broadcast", activationKind: "auto_single_actor" }
        : explicitWakeActorIds.length > 0
          ? { delivery: "direct" }
          : { delivery: "broadcast" },
    }).catch((err) => {
      console.error(`Failed to wake actor ${targetActorId}:`, err.message);
    });
  }

  return {
    item: await getConversationFeedItemById(item.id),
  };
}

export async function getConversationMessages(
  conversationId: string,
  viewer: { userId?: string; actorId?: string },
  limit = 100,
  before?: string,
): Promise<{ items: any[]; hasMore: boolean; nextBeforeSequence?: number }> {
  const conversation = await getConversation(conversationId);
  if (!conversation) return { items: [], hasMore: false };

  const viewerMember = viewer.userId
    ? await getConversationMember({
        conversationId: conversationId,
        userId: viewer.userId,
      })
    : viewer.actorId
      ? await getConversationMember({
          conversationId: conversationId,
          actorId: viewer.actorId,
        })
      : null;

  let beforeSequence: number | undefined;
  if (before) {
    const itemResult = await query(
      `SELECT sequence FROM conversation_items WHERE id = $1 AND conversation_id = $2`,
      [before, conversationId],
    );
    if (itemResult.rows[0]) {
      beforeSequence = itemResult.rows[0].sequence;
    } else if (!Number.isNaN(Number(before))) {
      beforeSequence = Number(before);
    }
  }

  const items = viewerMember
    ? await getVisibleConversationItemsForMember({
        conversationId: conversationId,
        memberId: viewerMember.id,
        beforeSequence,
        limit: limit + 1,
      })
    : await getSharedVisibleConversationItems({
        conversationId: conversationId,
        beforeSequence,
        limit: limit + 1,
      });
  const hasMore = items.length > limit;
  const pageItems = hasMore ? items.slice(1) : items;

  return {
    items: pageItems.map((item: any) => conversationItemRowToFeedItem(item)),
    hasMore,
    nextBeforeSequence: pageItems[0]?.sequence
      ? Number(pageItems[0].sequence)
      : undefined,
  };
}

// ============ Actor Wake / Sleep ============

export async function wakeActor(params: {
  conversationId: string;
  actorId: string;
  sourceType:
    | "user_message"
    | "actor_message"
    | "broadcast"
    | "invite"
    | "api_call"
    | "system_interrupt"
    | "retry";
  sourceItemId?: string;
  sourceSessionId?: string;
  sourceMemberType?: "user" | "actor" | "external" | "system";
  sourceMemberId?: string;
  sourceName?: string;
  summary: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const conversation = await getConversation(params.conversationId);
  if (!conversation) return;

  let session = await ensureActorSession({
    conversationId: params.conversationId,
    workspaceId: conversation.workspace_id || undefined,
    actorId: params.actorId,
    trigger: params.sourceType,
  });
  session = await getSession(session.id);
  if (!session) return;

  await enqueueSessionWakeup({
    sessionId: session.id,
    actorId: params.actorId,
    workspaceId: session.workspace_id,
    sourceType: params.sourceType,
    sourceItemId: params.sourceItemId,
    sourceSessionId: params.sourceSessionId,
    sourceMemberType: params.sourceMemberType,
    sourceMemberId: params.sourceMemberId,
    sourceName: params.sourceName,
    summary: params.summary,
    metadata: params.metadata,
    trigger: params.sourceType,
  });
}

export async function sleepActor(sessionId: string): Promise<void> {
  const session = await getSession(sessionId);
  if (!session || session.status !== "running") return;

  await updateSessionStatus(sessionId, "idle", { errorMessage: null });
  await publishSessionRuntime(session.workspace_id, sessionId, {
    laneState: "idle",
    phase: "idle",
  });

  await emitEvent({
    type: "session.status.changed",
    workspaceId: session.workspace_id,
    payload: {
      conversationId: session.conversation_id,
      sessionId,
      actorId: session.actor_id,
      status: "idle",
      previousStatus: "running",
    },
    timestamp: nowISO(),
  });
}

export async function listConversationGrants(
  conversationId: string,
  workspaceId: string,
) {
  const result = await query<
    ConversationGrantRow & {
      id: string;
      conversation_id: string;
      created_at: string;
      revoked_at: string | null;
    }
  >(
    `SELECT *
     FROM conversation_grants
     WHERE conversation_id = $1
       AND workspace_id = $2
     ORDER BY created_at DESC`,
    [conversationId, workspaceId],
  );

  return result.rows.map(mapConversationGrant);
}

export async function issueConversationGrant(params: {
  conversationId: string;
  workspaceId: string;
  permission: ConversationGrantPermission;
  userId?: string;
  actorId?: string;
  grantedBy?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}) {
  const subjectType = params.userId ? "user" : "actor";
  if (!params.userId && !params.actorId) {
    throw new Error("userId or actorId is required");
  }

  if (params.userId) {
    await assertActiveConversationUserMember(
      params.conversationId,
      params.userId,
    );
  }
  if (params.actorId) {
    await assertActiveConversationActorMember(
      params.conversationId,
      params.actorId,
    );
  }

  const result = await transaction(async (client) => {
    const previousResult = await client.query<ConversationGrantRow>(
      `SELECT *
       FROM conversation_grants
       WHERE conversation_id = $1
         AND workspace_id = $2
         AND status = 'active'`,
      [params.conversationId, params.workspaceId],
    );
    const previous = previousResult.rows;

    const existingResult = await client.query<
      ConversationGrantRow & {
        id: string;
        conversation_id: string;
        created_at: string;
        revoked_at: string | null;
      }
    >(
      `SELECT *
       FROM conversation_grants
       WHERE conversation_id = $1
         AND workspace_id = $2
         AND permission = $3
         AND subject_type = $4
         AND COALESCE(user_id::text, '') = COALESCE($5::text, '')
         AND COALESCE(actor_id::text, '') = COALESCE($6::text, '')
         AND status = 'active'
       LIMIT 1`,
      [
        params.conversationId,
        params.workspaceId,
        params.permission,
        subjectType,
        params.userId ?? null,
        params.actorId ?? null,
      ],
    );

    if (existingResult.rows[0]) {
      return { grant: existingResult.rows[0], authzEntryIds: [] as string[] };
    }

    const insertResult = await client.query<
      ConversationGrantRow & {
        id: string;
        conversation_id: string;
        created_at: string;
        revoked_at: string | null;
      }
    >(
      `INSERT INTO conversation_grants (
         conversation_id,
         workspace_id,
         permission,
         subject_type,
         user_id,
         actor_id,
         status,
         granted_by,
         reason,
         metadata
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9::jsonb)
       RETURNING *`,
      [
        params.conversationId,
        params.workspaceId,
        params.permission,
        subjectType,
        params.userId ?? null,
        params.actorId ?? null,
        params.grantedBy ?? null,
        params.reason ?? null,
        JSON.stringify(params.metadata ?? {}),
      ],
    );

    const next = [...previous, insertResult.rows[0]];
    const authzEntryIds = await queueAuthzRelationships(
      client,
      diffAuthzRelationships(
        buildConversationGrantRelations(params.conversationId, previous),
        buildConversationGrantRelations(params.conversationId, next),
      ),
      {
        source: "conversation.issue_grant",
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        permission: params.permission,
      },
    );

    return {
      grant: insertResult.rows[0],
      authzEntryIds,
    };
  });

  await flushQueuedAuthzEntries(
    result.authzEntryIds,
    "conversation.issue_grant",
  );
  return mapConversationGrant(result.grant);
}

export async function revokeConversationGrant(params: {
  conversationId: string;
  workspaceId: string;
  grantId: string;
}) {
  const result = await transaction(async (client) => {
    const previousResult = await client.query<
      ConversationGrantRow & { id: string }
    >(
      `SELECT *
       FROM conversation_grants
       WHERE conversation_id = $1
         AND workspace_id = $2
         AND status = 'active'`,
      [params.conversationId, params.workspaceId],
    );
    const previous = previousResult.rows;

    const revokeResult = await client.query<
      ConversationGrantRow & {
        id: string;
        conversation_id: string;
        created_at: string;
        revoked_at: string | null;
      }
    >(
      `UPDATE conversation_grants
       SET status = 'revoked',
           revoked_at = NOW()
       WHERE id = $1
         AND conversation_id = $2
         AND workspace_id = $3
         AND status = 'active'
       RETURNING *`,
      [params.grantId, params.conversationId, params.workspaceId],
    );

    const revoked = revokeResult.rows[0];
    if (!revoked) {
      return null;
    }

    const next = previous.filter((grant) => grant.id !== params.grantId);
    const authzEntryIds = await queueAuthzRelationships(
      client,
      diffAuthzRelationships(
        buildConversationGrantRelations(params.conversationId, previous),
        buildConversationGrantRelations(params.conversationId, next),
      ),
      {
        source: "conversation.revoke_grant",
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        grantId: params.grantId,
      },
    );

    return {
      grant: revoked,
      authzEntryIds,
    };
  });

  if (!result) {
    return null;
  }

  await flushQueuedAuthzEntries(
    result.authzEntryIds,
    "conversation.revoke_grant",
  );
  return mapConversationGrant(result.grant);
}

async function assertActiveConversationUserMember(
  conversationId: string,
  userId: string,
) {
  const member = await getConversationMember({
    conversationId,
    userId,
  });
  if (!member || member.state !== "active") {
    throw new Error("User is not an active member of this conversation");
  }
}

async function assertActiveConversationActorMember(
  conversationId: string,
  actorId: string,
) {
  const member = await getConversationMember({
    conversationId,
    actorId,
  });
  if (!member || member.state !== "active") {
    throw new Error("Actor is not an active member of this conversation");
  }
}

// ============ Mark Read ============

export async function markConversationRead(
  userId: string,
  conversationId: string,
): Promise<void> {
  const lastItem = await getLastVisibleConversationItem(conversationId);
  await markConversationCursorRead(
    userId,
    conversationId,
    lastItem?.sequence ? Number(lastItem.sequence) : 0,
  );
}

// ============ Cancel Conversation ============

export async function cancelConversation(conversationId: string): Promise<void> {
  const closed = await query(
    `UPDATE sessions
     SET status = 'closed', completed_at = NOW(), updated_at = NOW()
     WHERE conversation_id = $1 AND status <> 'closed'
     RETURNING id`,
    [conversationId],
  );
  await Promise.all(
    closed.rows.map((row: any) => removeSessionRuntime(row.id)),
  );

  const conversation = await getConversation(conversationId);
  if (conversation) {
    await emitConversationUpdated({
      workspaceId: conversation.workspace_id,
      conversationId: conversationId,
      action: "cancelled",
    });
  }
}
