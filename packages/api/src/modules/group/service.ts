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
import { nowISO } from "@synapse/shared";
import { v4 as uuidv4 } from "uuid";
import {
  conversationItemRowToFeedItem,
  createConversationEvent,
  getConversationFeedItemById,
  createConversationItem,
  ensureConversationMember,
  getConversation,
  getConversationMember,
  getLastVisibleConversationItem,
  getSharedVisibleConversationItems,
  getVisibleConversationItemsForMember,
  listConversationMembers,
  listUserGroupConversations,
  markConversationRead,
} from "../conversation/service.js";
import { activateConversationParticipant } from "../conversation/participant-activation.js";
import {
  buildNormalizedMessageContent,
  itemPartsToCanonicalContentBlocks,
} from "../conversation/message-content.js";
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

function normalizeGroupRow(row: any) {
  if (!row) return null;
  return {
    ...row,
    group_id: row.id,
    avatar_url: row.avatar_url || avatarUrlFromConversationMetadata(row.metadata),
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

async function loadActorJoinVersionRefs(
  workspaceId: string,
  actorIds: string[],
) {
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
     WHERE a.workspace_id = $1
       AND a.id = ANY($2::uuid[])`,
    [workspaceId, actorIds],
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

function mapGroupMemberPayload(row: any) {
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
  const text = parts
    .filter((part) => part.part_type === "text")
    .map((part) => part.text_value || "")
    .join("\n");

  if (text) return text;

  const jsonParts = parts
    .filter((part) => part.part_type === "json")
    .map((part) => JSON.stringify(part.json_value));
  return jsonParts.join("\n");
}

async function emitChatFeedItem(workspaceId: string, itemId: string) {
  const item = await getConversationFeedItemById(itemId);
  if (!item || item.workspaceSequence === undefined) return;

  await emitEvent({
    type: "chat.feed.item.created",
    workspaceId,
    payload: {
      workspaceSequence: item.workspaceSequence,
      item,
    },
    timestamp: nowISO(),
  });
}

async function emitChatConversationUpdated(params: {
  workspaceId: string;
  conversationId: string;
  action: "created" | "profile_updated" | "cancelled";
  title?: string | null;
  avatarUrl?: string | null;
}) {
  await emitEvent({
    type: "chat.conversation.updated",
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
  workspaceId: string;
  actorId: string;
  trigger: string;
}) {
  const existing = await getLatestActorSession(
    params.conversationId,
    params.actorId,
  );
  if (existing) return existing;

  return createSession({
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    conversationId: params.conversationId,
    channelType: "web",
    trigger: params.trigger,
    metadata: { lane: "group" },
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
  workspaceId: string;
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

  await emitChatFeedItem(params.workspaceId, created.item.id);
  return created;
}

async function resolveMemberTargets(params: {
  groupId: string;
  members?: any[];
  targetParticipantIds?: string[];
  targetActorIds?: string[];
  targetUserIds?: string[];
}) {
  const members =
    params.members || (await listConversationMembers(params.groupId));
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

// ============ Group CRUD ============

export async function createGroup(params: {
  workspaceId: string;
  createdBy: string;
  title?: string;
  actorIds: string[];
  initialMessage?: string;
  targetActorId?: string;
  includeCreatorMember?: boolean;
}): Promise<{ group: any; members: any[]; message: any }> {
  const {
    workspaceId,
    createdBy,
    title,
    actorIds,
    initialMessage,
    targetActorId,
    includeCreatorMember = true,
  } = params;
  const groupId = uuidv4();
  const batchId = uuidv4();
  const actorJoinVersionRefs = await loadActorJoinVersionRefs(workspaceId, actorIds);

  const result = await transaction(async (client) => {
    const actorRows =
      actorIds.length > 0
        ? (
            await client.query(
              `SELECT id, name, title FROM actors WHERE id = ANY($1)`,
              [actorIds],
            )
          ).rows
        : [];
    const userRow = (
      await client.query(
        `SELECT name
         FROM users
         WHERE id = $1`,
        [createdBy],
      )
    ).rows[0];
    const actorMap = new Map<string, any>(
      actorRows.map((row: any) => [row.id, row]),
    );
    const fallbackTitle =
      title?.trim() ||
      actorRows
        .map((row: any) => row.name)
        .filter(Boolean)
        .join(", ") ||
      "Untitled conversation";

    const conversationResult = await client.query(
      `INSERT INTO conversations (id, workspace_id, kind, title, created_by, metadata, created_at, updated_at)
       VALUES ($1, $2, 'group', $3, $4, '{}'::jsonb, NOW(), NOW())
       RETURNING *`,
      [groupId, workspaceId, fallbackTitle, createdBy],
    );
    const group = normalizeGroupRow(conversationResult.rows[0]);

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

    let userMemberId: string | undefined;
    if (includeCreatorMember) {
      userMemberId = uuidv4();
      await client.query(
        `INSERT INTO conversation_members
           (id, conversation_id, member_type, user_id, state, metadata, joined_at)
         VALUES ($1, $2, 'user', $3, 'active', '{}'::jsonb, NOW())`,
        [userMemberId, groupId, createdBy],
      );

      joinedMembers.push({
        participantId: userMemberId,
        memberId: userMemberId,
        memberType: "user" as const,
        userId: createdBy,
        name: userRow?.name || "User",
      });
    }

    for (const actorId of actorIds) {
      const sessionId = uuidv4();
      await client.query(
        `INSERT INTO sessions
           (id, workspace_id, actor_id, conversation_id, channel_type, trigger, status, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'web', 'user_message', 'idle', '{}'::jsonb, NOW(), NOW())`,
        [sessionId, workspaceId, actorId, groupId],
      );

      const memberId = uuidv4();
      await client.query(
        `INSERT INTO conversation_members
           (id, conversation_id, member_type, actor_id, actor_join_version_id, state, metadata, joined_at)
         VALUES ($1, $2, 'actor', $3, $4, 'active', '{}'::jsonb, NOW())`,
        [
          memberId,
          groupId,
          actorId,
          actorJoinVersionRefs.get(actorId) || null,
        ],
      );
      members.push({ id: memberId, actorId, sessionId });

      const actorInfo = actorMap.get(actorId);
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
        touchRelation(
          "conversation",
          groupId,
          "workspace",
          "workspace",
          workspaceId,
        ),
        touchRelation("conversation", groupId, "admin", "user", createdBy),
        ...(includeCreatorMember
          ? [
              touchRelation(
                "conversation",
                groupId,
                "participant",
                "user",
                createdBy,
              ),
            ]
          : []),
        ...actorIds.flatMap((actorId) => [
          touchRelation(
            "conversation",
            groupId,
            "participant",
            "actor",
            actorId,
          ),
          ...touchActorConversationContext(actorId, groupId),
        ]),
      ],
      {
        source: "group.create",
        workspaceId,
        groupId,
        createdBy,
      },
    );

    return {
      group,
      members,
      joinedMembers,
      creatorName: userRow?.name || "User",
      authzEntryIds,
    };
  });

  await flushQueuedAuthzEntries(result.authzEntryIds, "group.create");

  if (result.joinedMembers.length > 0) {
    const creatorMember = result.joinedMembers.find(
      (member) => member.memberType === "user" && member.userId === createdBy,
    );
    await recordMembershipEvent({
      workspaceId,
      conversationId: groupId,
      subtype: "member_joined",
      batchId,
      authorMemberId: creatorMember?.memberId || result.joinedMembers[0]?.memberId,
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

  await Promise.all(
    result.members.map((member: any) =>
      publishSessionRuntime(workspaceId, member.sessionId),
    ),
  );

  if (targetActorId && initialMessage) {
    await sendGroupMessage({
      groupId,
      senderType: "user",
      senderUserId: createdBy,
      content: initialMessage,
      targetActorIds: [targetActorId],
    });
  }

  await emitChatConversationUpdated({
    workspaceId,
    conversationId: groupId,
    action: "created",
  });

  await emitEvent({
    type: "group.updated",
    workspaceId,
    payload: { groupId, action: "created" },
    timestamp: nowISO(),
  });

  return {
    group: result.group,
    members: result.members,
    message: null,
  };
}

export async function getGroup(groupId: string): Promise<any | null> {
  const result = await query(
    `SELECT * FROM conversations WHERE id = $1 AND kind = 'group'`,
    [groupId],
  );
  return normalizeGroupRow(result.rows[0] ?? null);
}

export async function updateGroupProfile(params: {
  groupId: string;
  workspaceId: string;
  updatedBy: string;
  title?: string;
  avatarFileId?: string | null;
}) {
  const group = await getGroup(params.groupId);
  if (!group || group.workspace_id !== params.workspaceId) {
    throw new Error("Group not found");
  }

  const currentMetadata = parseConversationMetadata(group.metadata);
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
  const nextTitle = title === undefined ? group.title : title || group.title;

  const result = await query(
    `UPDATE conversations
     SET title = $2,
         metadata = $3::jsonb,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [params.groupId, nextTitle, JSON.stringify(nextMetadata)],
  );

  const updated = normalizeGroupRow(result.rows[0]);

  await emitChatConversationUpdated({
    workspaceId: params.workspaceId,
    conversationId: params.groupId,
    action: "profile_updated",
    title: updated.title,
    avatarUrl: updated.avatar_url || null,
  });

  await emitEvent({
    type: "group.updated",
    workspaceId: params.workspaceId,
    payload: {
      groupId: params.groupId,
      action: "profile_updated",
      title: updated.title,
      avatarUrl: updated.avatar_url || null,
    },
    timestamp: nowISO(),
  });

  return updated;
}

export async function getGroupsByWorkspace(
  workspaceId: string,
  userId: string,
  groupIds?: string[],
): Promise<any[]> {
  const groups = groupIds
    ? groupIds.length > 0
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
                      AND ci.sequence > COALESCE(cr.last_read_sequence, 0)
                  ) AS unread_count
           FROM conversations c
           LEFT JOIN conversation_transport_bindings ctb
             ON ctb.conversation_id = c.id
           LEFT JOIN transport_accounts transport_account
             ON transport_account.id = ctb.transport_account_id
           LEFT JOIN conversation_reads cr ON cr.conversation_id = c.id AND cr.user_id = $2
           WHERE c.workspace_id = $1
             AND c.kind = 'group'
             AND c.id = ANY($3)
           ORDER BY c.updated_at DESC, c.created_at DESC`,
            [workspaceId, userId, groupIds],
          )
        ).rows
      : []
    : await listUserGroupConversations(workspaceId, userId);
  if (groups.length === 0) return [];

  const resolvedGroupIds = groups.map((group: any) => group.id);
  const activeCountsResult = await query(
    `SELECT conversation_id, COUNT(*)::int AS active_count
     FROM sessions
     WHERE conversation_id = ANY($1)
       AND status <> 'closed'
     GROUP BY conversation_id`,
    [resolvedGroupIds],
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
     ORDER BY ci.conversation_id, ci.sequence DESC`,
    [resolvedGroupIds],
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

  return groups.map((group: any) => {
    const lastItem = lastItemMap.get(group.id);
    const lastParts = lastItem ? partsByItem.get(lastItem.id) || [] : [];
    const senderType = lastItem
      ? senderTypeFromItem({
          ...lastItem,
          author_member_type: lastItem.author_member_type,
        })
      : null;

    return {
      ...normalizeGroupRow(group),
      last_message: lastItem ? buildTextContentFromParts(lastParts) : null,
      last_message_sender_type: senderType,
      last_message_sender_name: lastItem?.author_name || "System",
      last_message_at: lastItem?.created_at || null,
      unread_count: group.unread_count || 0,
      active_count: activeCountMap.get(group.id) || 0,
    };
  });
}

// ============ Member Management ============

export async function addActorToGroup(
  groupId: string,
  actorId: string,
  _inviterActorName?: string,
  batchId?: string,
): Promise<{ member: any; session: any }> {
  const group = await getGroup(groupId);
  if (!group) throw new Error("Group not found");
  const actorJoinVersionId = (await loadActorJoinVersionRefs(group.workspace_id, [actorId])).get(actorId);

  const existing = await getConversationMember({
    conversationId: groupId,
    actorId,
  });
  if (existing?.state === "active") {
    throw new Error("Actor already in group");
  }

  const actorResult = await query(
    `SELECT name, title FROM actors WHERE id = $1`,
    [actorId],
  );
  const actorInfo = actorResult.rows[0];
  const result = await transaction(async (client) => {
    const member = await ensureConversationMember({
      conversationId: groupId,
      memberType: "actor",
      actorId,
      actorJoinVersionId,
    });
    const session = await createSession({
      workspaceId: group.workspace_id,
      actorId,
      conversationId: groupId,
      channelType: "web",
      trigger: "actor_invite",
      metadata: { lane: "group" },
    });

    const authzEntryIds = await queueAuthzRelationships(
      client,
      [
        touchRelation("conversation", groupId, "participant", "actor", actorId),
        ...touchActorConversationContext(actorId, groupId),
      ],
      {
        source: "group.add_actor",
        groupId,
        actorId,
      },
    );

    return { member, session, authzEntryIds };
  });

  await flushQueuedAuthzEntries(result.authzEntryIds, "group.add_actor");
  await publishSessionRuntime(group.workspace_id, result.session.id);

  const eventBatchId = batchId || uuidv4();
  await recordMembershipEvent({
    workspaceId: group.workspace_id,
    conversationId: groupId,
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

  await emitEvent({
    type: "group.member_joined",
    workspaceId: group.workspace_id,
    payload: {
      groupId,
      actorId,
      actorName: actorInfo?.name || "Unknown",
      batchId: eventBatchId,
      members: [
        {
          memberId: result.member.id,
          type: "actor" as const,
          actorId,
          name: actorInfo?.name || "Unknown",
          title: actorInfo?.title,
        },
      ],
    },
    timestamp: nowISO(),
  });

  return {
    member: {
      id: result.member.id,
      groupId,
      actorId,
      sessionId: result.session.id,
    },
    session: { id: result.session.id },
  };
}

export async function addMembersToGroup(params: {
  groupId: string;
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

  const group = await getGroup(params.groupId);
  if (!group || group.workspace_id !== params.workspaceId) {
    throw new Error("Group not found");
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
  const actorJoinVersionRefs = await loadActorJoinVersionRefs(params.workspaceId, actorIds);
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
        conversationId: params.groupId,
        actorId,
      });
      if (existing?.state === "active") continue;

      const member = await ensureConversationMember({
        conversationId: params.groupId,
        memberType: "actor",
        actorId,
        actorJoinVersionId: actorJoinVersionRefs.get(actorId),
      });
      const session = await createSession({
        workspaceId: params.workspaceId,
        actorId,
        conversationId: params.groupId,
        channelType: "web",
        trigger: "actor_invite",
        metadata: { lane: "group" },
      });

      const actorInfo = actorMap.get(actorId)!;
      relationships.push(
        touchRelation(
          "conversation",
          params.groupId,
          "participant",
          "actor",
          actorId,
        ),
        ...touchActorConversationContext(actorId, params.groupId),
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
        conversationId: params.groupId,
        userId,
      });
      if (existing?.state === "active") continue;

      const member = await ensureConversationMember({
        conversationId: params.groupId,
        memberType: "user",
        userId,
      });
      const userInfo = userMap.get(userId)!;
      relationships.push(
        touchRelation(
          "conversation",
          params.groupId,
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
      source: "group.add_members",
      groupId: params.groupId,
      actorIds,
      userIds,
    });

    return {
      addedMembers,
      joinedMembers,
      authzEntryIds,
    };
  });

  await flushQueuedAuthzEntries(result.authzEntryIds, "group.add_members");
  await Promise.all(
    result.addedMembers
      .filter((member: any) => member.type === "actor" && member.actorId)
      .map(async (member: any) => {
        const session = await getLatestActorSession(
          params.groupId,
          member.actorId,
        );
        if (session) {
          await publishSessionRuntime(params.workspaceId, session.id);
        }
      }),
  );

  if (result.joinedMembers.length > 0) {
    const initiator = await hydrateMembershipInitiator({
      conversationId: params.groupId,
      initiator: params.initiator,
    });
    await recordMembershipEvent({
      workspaceId: params.workspaceId,
      conversationId: params.groupId,
      subtype: "member_joined",
      batchId,
      authorMemberId: initiator?.memberId,
      initiator,
      members: result.joinedMembers,
    });

    await emitEvent({
      type: "group.member_joined",
      workspaceId: params.workspaceId,
      payload: {
        groupId: params.groupId,
        batchId,
        initiator,
        members: result.addedMembers,
      },
      timestamp: nowISO(),
    });
  }

  return { members: result.addedMembers };
}

export async function removeActorFromGroup(
  groupId: string,
  actorId: string,
): Promise<void> {
  const group = await getGroup(groupId);
  if (!group) throw new Error("Group not found");

  const member = await getConversationMember({
    conversationId: groupId,
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
        [groupId, actorId],
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
              groupId,
              "participant",
              "actor",
              actorId,
            ),
            deleteRelation(
              "actor_conversation",
              buildActorConversationContextId(actorId, groupId),
              "actor",
              "actor",
              actorId,
            ),
            deleteRelation(
              "actor_conversation",
              buildActorConversationContextId(actorId, groupId),
              "conversation",
              "conversation",
              groupId,
            ),
          ],
          {
            source: "group.remove_actor",
            groupId,
            actorId,
          },
        ),
      };
    },
  );

  await flushQueuedAuthzEntries(authzEntryIds, "group.remove_actor");
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
    workspaceId: group.workspace_id,
    conversationId: groupId,
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

  await emitEvent({
    type: "group.member_kicked",
    workspaceId: group.workspace_id,
    payload: {
      groupId,
      actorId,
      actorName: actorInfo?.name || "Unknown",
      batchId: eventBatchId,
      members: [
        {
          memberId: member.id,
          type: "actor" as const,
          actorId,
          name: actorInfo?.name || "Unknown",
          title: actorInfo?.title,
        },
      ],
    },
    timestamp: nowISO(),
  });
}

export async function getGroupMembers(
  groupId: string,
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
    [groupId],
  );
  return result.rows.map((row: any) => ({
    ...row,
    group_id: groupId,
  }));
}

// ============ Group Messages ============

export async function sendGroupMessage(params: {
  groupId: string;
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
    groupId,
    senderType,
    senderUserId,
    senderActorId,
    senderSessionId,
    clientMessageId,
    content,
    contentBlocks,
    metadata = {},
  } = params;
  const group = await getGroup(groupId);
  if (!group) throw new Error("Group not found");

  await requireConversationSendPermission({
    conversationId: groupId,
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
            workspaceId: group.workspace_id,
            conversationId: groupId,
            memberType: "actor",
            actorId: senderActorId,
            actorJoinVersionId: senderActorId
              ? (await loadActorJoinVersionRefs(group.workspace_id, [senderActorId])).get(senderActorId)
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
            workspaceId: group.workspace_id,
            conversationId: groupId,
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

  const members = await listConversationMembers(groupId);
  const requestedTargetMemberIds = await resolveMemberTargets({
    groupId,
    members,
    targetParticipantIds: requestedTargetParticipantIds,
    targetActorIds: requestedTargetActorIds,
    targetUserIds: requestedTargetUserIds,
  });
  const membersById = new Map(
    members.map((member: any) => [member.id as string, member]),
  );
  const requestedTargetActorIdsFromMembers = getActorIdsFromTargetMembers({
    members,
    targetMemberIds: requestedTargetMemberIds,
  });
  const allowedTargetActorIds = await filterAllowedTargetActorIds({
    conversationId: groupId,
    senderType,
    senderUserId,
    senderActorId,
    targetActorIds: requestedTargetActorIdsFromMembers,
    explicit: requestedTargetActorIdsFromMembers.length > 0,
  });
  const allowedTargetActorIdSet = new Set(allowedTargetActorIds);
  const targetMemberIds = requestedTargetMemberIds.filter((targetMemberId) => {
    const member = membersById.get(targetMemberId);
    if (!member?.actor_id) return true;
    return allowedTargetActorIdSet.has(member.actor_id);
  });
  const transportBinding =
    targetMemberIds.length > 0
      ? await getConversationTransportBinding({
          workspaceId: group.workspace_id,
          conversationId: groupId,
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
  const explicitWakeActorIds = getActorIdsFromTargetMembers({
    members,
    targetMemberIds,
  });
  const automaticWakeCandidateIds = getAutomaticWakeActorIds({
    members,
    senderType,
    senderUserId,
    hasExplicitTargets,
  });
  const automaticWakeActorIds = await filterAllowedTargetActorIds({
    conversationId: groupId,
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
    metadata,
  });
  let item: any;
  try {
    item = await createConversationItem({
      workspaceId: group.workspace_id,
      conversationId: groupId,
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
        conversationId: groupId,
        authorMemberId: authorMember.id,
        clientMessageId,
      });
      if (existing) {
        return { item: existing };
      }
    }
    throw error;
  }

  await emitChatFeedItem(group.workspace_id, item.id);
  if (hasExplicitTransportTargets) {
    await queueConversationTransportProjection({
      workspaceId: group.workspace_id,
      conversationId: groupId,
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
      groupId,
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

export async function getGroupMessages(
  groupId: string,
  viewer: { userId?: string; actorId?: string },
  limit = 100,
  before?: string,
): Promise<{ items: any[]; hasMore: boolean; nextBeforeSequence?: number }> {
  const group = await getGroup(groupId);
  if (!group) return { items: [], hasMore: false };

  const viewerMember = viewer.userId
    ? await getConversationMember({
        conversationId: groupId,
        userId: viewer.userId,
      })
    : viewer.actorId
      ? await getConversationMember({
          conversationId: groupId,
          actorId: viewer.actorId,
        })
      : null;

  let beforeSequence: number | undefined;
  if (before) {
    const itemResult = await query(
      `SELECT sequence FROM conversation_items WHERE id = $1 AND conversation_id = $2`,
      [before, groupId],
    );
    if (itemResult.rows[0]) {
      beforeSequence = itemResult.rows[0].sequence;
    } else if (!Number.isNaN(Number(before))) {
      beforeSequence = Number(before);
    }
  }

  const items = viewerMember
    ? await getVisibleConversationItemsForMember({
        conversationId: groupId,
        memberId: viewerMember.id,
        beforeSequence,
        limit: limit + 1,
      })
    : await getSharedVisibleConversationItems({
        conversationId: groupId,
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
  groupId: string;
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
  const group = await getGroup(params.groupId);
  if (!group) return;

  let session = await ensureActorSession({
    conversationId: params.groupId,
    workspaceId: group.workspace_id,
    actorId: params.actorId,
    trigger: params.sourceType,
  });
  session = await getSession(session.id);
  if (!session) return;

  await enqueueSessionWakeup({
    sessionId: session.id,
    actorId: params.actorId,
    workspaceId: group.workspace_id,
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
      groupId: session.group_id,
      sessionId,
      actorId: session.actor_id,
      status: "idle",
      previousStatus: "running",
    },
    timestamp: nowISO(),
  });
}

export async function listConversationGrants(
  groupId: string,
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
    [groupId, workspaceId],
  );

  return result.rows.map(mapConversationGrant);
}

export async function issueConversationGrant(params: {
  groupId: string;
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
    await assertActiveConversationUserMember(params.groupId, params.userId);
  }
  if (params.actorId) {
    await assertActiveConversationActorMember(params.groupId, params.actorId);
  }

  const result = await transaction(async (client) => {
    const previousResult = await client.query<ConversationGrantRow>(
      `SELECT *
       FROM conversation_grants
       WHERE conversation_id = $1
         AND workspace_id = $2
         AND status = 'active'`,
      [params.groupId, params.workspaceId],
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
        params.groupId,
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
        params.groupId,
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
        buildConversationGrantRelations(params.groupId, previous),
        buildConversationGrantRelations(params.groupId, next),
      ),
      {
        source: "conversation.issue_grant",
        workspaceId: params.workspaceId,
        conversationId: params.groupId,
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
  groupId: string;
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
      [params.groupId, params.workspaceId],
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
      [params.grantId, params.groupId, params.workspaceId],
    );

    const revoked = revokeResult.rows[0];
    if (!revoked) {
      return null;
    }

    const next = previous.filter((grant) => grant.id !== params.grantId);
    const authzEntryIds = await queueAuthzRelationships(
      client,
      diffAuthzRelationships(
        buildConversationGrantRelations(params.groupId, previous),
        buildConversationGrantRelations(params.groupId, next),
      ),
      {
        source: "conversation.revoke_grant",
        workspaceId: params.workspaceId,
        conversationId: params.groupId,
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
  groupId: string,
  userId: string,
) {
  const member = await getConversationMember({
    conversationId: groupId,
    userId,
  });
  if (!member || member.state !== "active") {
    throw new Error("User is not an active member of this conversation");
  }
}

async function assertActiveConversationActorMember(
  groupId: string,
  actorId: string,
) {
  const member = await getConversationMember({
    conversationId: groupId,
    actorId,
  });
  if (!member || member.state !== "active") {
    throw new Error("Actor is not an active member of this conversation");
  }
}

// ============ Mark Read ============

export async function markGroupRead(
  userId: string,
  groupId: string,
): Promise<void> {
  const lastItem = await getLastVisibleConversationItem(groupId);
  await markConversationRead(
    userId,
    groupId,
    lastItem?.sequence ? Number(lastItem.sequence) : 0,
  );
}

// ============ Cancel Group ============

export async function cancelGroup(groupId: string): Promise<void> {
  const closed = await query(
    `UPDATE sessions
     SET status = 'closed', completed_at = NOW(), updated_at = NOW()
     WHERE conversation_id = $1 AND status <> 'closed'
     RETURNING id`,
    [groupId],
  );
  await Promise.all(
    closed.rows.map((row: any) => removeSessionRuntime(row.id)),
  );

  const group = await getGroup(groupId);
  if (group) {
    await emitChatConversationUpdated({
      workspaceId: group.workspace_id,
      conversationId: groupId,
      action: "cancelled",
    });
    await emitEvent({
      type: "group.updated",
      workspaceId: group.workspace_id,
      payload: { groupId, action: "cancelled" },
      timestamp: nowISO(),
    });
  }
}
