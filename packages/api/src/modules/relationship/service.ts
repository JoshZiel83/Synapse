import { sql } from "kysely";
import { v4 as uuidv4 } from "uuid";
import { transaction } from "../../infrastructure/database/index.js";
import {
  db,
  executeCompiledQuery,
  executeTakeFirst,
  type TableInsert,
} from "../../infrastructure/database/kysely.js";
import {
  buildWorkspaceUserContextId,
  deleteRelation,
  enqueueAuthzRelationships,
  flushAuthzOutboxEntries,
  queueAuthzRelationships,
  touchRelation,
  touchWorkspaceUserContext,
} from "../../infrastructure/authz/index.js";
import { getFileUrl } from "../../infrastructure/storage/index.js";
import { getFileUrlById } from "../files/service.js";
import {
  authorizeAction,
  userSubject,
} from "../access/service.js";
import {
  createThread,
  getThreadsForUser,
} from "../conversation/chat-service.js";
import { getWorkspaceMemberIdentity } from "../conversation/workspace-identity.js";
import {
  canonicalizeDirectConversationPair,
  directConversationBindingPeer,
  directConversationBindingValues,
  directConversationIdentityKey,
  type DirectConversationIdentity,
} from "../conversation/direct-binding.js";
import { mapConversationSummaryView } from "../conversation/summary-view.js";

export const CONTACT_HUB_KINDS = [
  "workspace-actor",
  "workspace-user",
  "friend-actor",
  "friend-user",
] as const;

export type ContactHubKind = (typeof CONTACT_HUB_KINDS)[number];

type ApprovalMode = "auto" | "manual";
type AccessPolicy = "workspace_open" | "approval_required";
type RequestStatus = "pending" | "approved" | "rejected";
type ContactTargetType = "user" | "actor";
type FriendSearchOutcome =
  | "empty"
  | "invalid"
  | "self"
  | "not_found"
  | "found";
type FriendSearchMatchState =
  | "same_workspace_user"
  | "friend"
  | "pending_request"
  | "requestable";

type WorkspaceSummary = {
  id: string;
  name: string;
  slug: string;
};

type UserWorkspaceSummary = {
  workspace: WorkspaceSummary;
  workspaceMemberId: string;
  userId: string;
  name: string;
  email: string;
  avatarFileId?: string | null;
  trustLevel?: string;
};

type ActorSummary = {
  workspace: WorkspaceSummary;
  actorId: string;
  name: string;
  title: string;
  role: string;
  avatarStoredName?: string | null;
  avatarEmoji?: string | null;
  accessPolicy: AccessPolicy;
};

type ContactHubEntry = {
  kind: ContactHubKind;
  id: string;
  targetType: ContactTargetType;
  title: string;
  subtitle?: string;
  avatarUrl?: string;
  avatarEmoji?: string;
  workspace: WorkspaceSummary;
  workspaceMemberId?: string;
  userId?: string;
  actorId?: string;
  relationLabel: string;
  directState: {
    status: "existing" | "available" | "approval_required" | "pending_approval";
    conversationId?: string;
  };
};

const FRIEND_SEARCH_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{3,31})$/;

function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

function toIsoString(value: string | Date | null | undefined) {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return new Date(0).toISOString();
}

function normalizeFriendSearchId(value: string) {
  return value.trim().toLowerCase();
}

function validateFriendSearchId(value: string) {
  const normalized = normalizeFriendSearchId(value);
  if (!FRIEND_SEARCH_ID_PATTERN.test(normalized)) {
    throw new Error(
      "Friend ID must be 4-32 characters using letters, numbers, dot, underscore, or hyphen.",
    );
  }
  return normalized;
}

function buildRelationshipQrUrl(token: string) {
  return `synapse://relationship-qr?token=${encodeURIComponent(token)}`;
}

function workspaceSummary(row: {
  workspace_id?: string;
  workspace_name?: string;
  workspace_slug?: string;
  id?: string;
  name?: string;
  slug?: string;
}) {
  return {
    id: row.workspace_id || row.id || "",
    name: row.workspace_name || row.name || "Unknown workspace",
    slug: row.workspace_slug || row.slug || "",
  };
}

async function flushAuthzEntries(entryIds: string[], source: string) {
  if (entryIds.length === 0) return;
  try {
    await flushAuthzOutboxEntries(entryIds);
  } catch (error) {
    console.error(`[authz] Failed to flush ${source}:`, error);
  }
}

async function getWorkspaceById(workspaceId: string): Promise<WorkspaceSummary | null> {
  const row = await db
    .selectFrom("workspaces")
    .select(["id", "name", "slug"])
    .where("id", "=", workspaceId)
    .executeTakeFirst();
  return row ? workspaceSummary(row) : null;
}

async function getWorkspaceUserSummary(
  workspaceId: string,
  userId: string,
): Promise<UserWorkspaceSummary | null> {
  const row = await db
    .selectFrom("workspace_members as wm")
    .innerJoin("users as u", "u.id", "wm.user_id")
    .innerJoin("workspaces as w", "w.id", "wm.workspace_id")
    .select([
      "wm.id as workspace_member_id",
      "wm.workspace_id",
      "w.name as workspace_name",
      "w.slug as workspace_slug",
      "wm.user_id",
      "wm.trust_level",
      "u.name",
      "u.email",
      "u.avatar_file_id",
    ])
    .where("wm.workspace_id", "=", workspaceId)
    .where("wm.user_id", "=", userId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    workspace: workspaceSummary(row),
    workspaceMemberId: row.workspace_member_id,
    userId: row.user_id,
    trustLevel: row.trust_level,
    name: row.name,
    email: row.email,
    avatarFileId: row.avatar_file_id,
  };
}

async function getUserFriendSearchProfileRow(userId: string) {
  const row = await db
    .selectFrom("users")
    .select(["id", "friend_search_id", "friend_search_enabled"])
    .where("id", "=", userId)
    .executeTakeFirst();
  if (!row) {
    throw new Error("User not found");
  }
  return row;
}

async function getActorSummary(actorId: string): Promise<ActorSummary | null> {
  const row = await db
    .selectFrom("actors as a")
    .innerJoin("workspaces as w", "w.id", "a.workspace_id")
    .leftJoin("files as avatar_file", "avatar_file.id", "a.avatar_file_id")
    .select([
      "a.id as actor_id",
      "a.workspace_id",
      "w.name as workspace_name",
      "w.slug as workspace_slug",
      "a.name",
      "a.title",
      "a.role",
      "a.access_policy",
      "a.avatar_emoji",
      "avatar_file.stored_name as avatar_stored_name",
    ])
    .where("a.id", "=", actorId)
    .where("a.is_active", "=", true)
    .executeTakeFirst();
  if (!row) return null;
  return {
    workspace: workspaceSummary(row),
    actorId: row.actor_id,
    name: row.name,
    title: row.title,
    role: row.role,
    avatarStoredName: row.avatar_stored_name,
    avatarEmoji: row.avatar_emoji,
    accessPolicy: row.access_policy as AccessPolicy,
  };
}

function mapUserFriendEntry(params: {
  entryId: string;
  peer: UserWorkspaceSummary;
  conversationId?: string;
}): ContactHubEntry {
  return {
    kind: "friend-user",
    id: params.entryId,
    targetType: "user",
    title: params.peer.name || params.peer.email || "Unknown user",
    subtitle: `${params.peer.workspace.name} · ${params.peer.email}`,
    avatarUrl: params.peer.avatarFileId
      ? getFileUrlById(params.peer.avatarFileId)
      : undefined,
    workspace: params.peer.workspace,
    workspaceMemberId: params.peer.workspaceMemberId,
    userId: params.peer.userId,
    relationLabel: "Friend",
    directState: params.conversationId
      ? { status: "existing", conversationId: params.conversationId }
      : { status: "available" },
  };
}

function mapActorFriendEntry(params: {
  entryId: string;
  actor: ActorSummary;
  conversationId?: string;
}): ContactHubEntry {
  return {
    kind: "friend-actor",
    id: params.entryId,
    targetType: "actor",
    title: params.actor.name,
    subtitle: `${params.actor.workspace.name} · ${params.actor.title}`,
    avatarUrl: params.actor.avatarStoredName
      ? getFileUrl(params.actor.avatarStoredName)
      : undefined,
    avatarEmoji: params.actor.avatarEmoji || undefined,
    workspace: params.actor.workspace,
    actorId: params.actor.actorId,
    relationLabel: "Friend",
    directState: params.conversationId
      ? { status: "existing", conversationId: params.conversationId }
      : { status: "available" },
  };
}

function mapWorkspaceUserEntry(params: {
  user: UserWorkspaceSummary;
  conversationId?: string;
}): ContactHubEntry {
  return {
    kind: "workspace-user",
    id: params.user.userId,
    targetType: "user",
    title: params.user.name || params.user.email || "Unknown user",
    subtitle: `${params.user.email} · ${params.user.trustLevel || "member"}`,
    avatarUrl: params.user.avatarFileId
      ? getFileUrlById(params.user.avatarFileId)
      : undefined,
    workspace: params.user.workspace,
    workspaceMemberId: params.user.workspaceMemberId,
    userId: params.user.userId,
    relationLabel: "Workspace user",
    directState: params.conversationId
      ? { status: "existing", conversationId: params.conversationId }
      : { status: "available" },
  };
}

function mapWorkspaceActorEntry(params: {
  actor: ActorSummary;
  conversationId?: string;
  accessState: "existing" | "available" | "approval_required" | "pending_approval";
}): ContactHubEntry {
  return {
    kind: "workspace-actor",
    id: params.actor.actorId,
    targetType: "actor",
    title: params.actor.name,
    subtitle: params.actor.title,
    avatarUrl: params.actor.avatarStoredName
      ? getFileUrl(params.actor.avatarStoredName)
      : undefined,
    avatarEmoji: params.actor.avatarEmoji || undefined,
    workspace: params.actor.workspace,
    actorId: params.actor.actorId,
    relationLabel: "Workspace actor",
    directState:
      params.accessState === "existing"
        ? { status: "existing", conversationId: params.conversationId }
        : { status: params.accessState },
  };
}

async function ensureRelationshipProfile(params: {
  workspaceId: string;
  createdBy: string;
  subjectType: ContactTargetType;
  subjectUserId?: string;
  subjectActorId?: string;
}) {
  let queryBuilder = db
    .selectFrom("workspace_relationship_profiles")
    .selectAll()
    .where("workspace_id", "=", params.workspaceId)
    .where("subject_type", "=", params.subjectType);
  queryBuilder =
    params.subjectType === "user"
      ? queryBuilder.where("subject_user_id", "=", params.subjectUserId || null)
      : queryBuilder.where("subject_actor_id", "=", params.subjectActorId || null);
  const existing = await queryBuilder.executeTakeFirst();
  if (existing) return existing;

  const inserted = await db
    .insertInto("workspace_relationship_profiles")
    .values({
      workspace_id: params.workspaceId,
      subject_type: params.subjectType,
      subject_user_id: params.subjectType === "user" ? params.subjectUserId || null : null,
      subject_actor_id: params.subjectType === "actor" ? params.subjectActorId || null : null,
      qr_token: uuidv4(),
      created_by: params.createdBy,
      approval_mode: "manual",
    })
    .returningAll()
    .executeTakeFirst();
  if (!inserted) {
    throw new Error("Failed to create relationship profile");
  }
  return inserted;
}

async function updateActorAccessPolicy(params: {
  workspaceId: string;
  actorId: string;
  updatedBy: string;
  accessPolicy: AccessPolicy;
}) {
  const actor = await db
    .selectFrom("actors")
    .select(["id", "workspace_id", "access_policy"])
    .where("id", "=", params.actorId)
    .executeTakeFirst();
  if (!actor || actor.workspace_id !== params.workspaceId) {
    throw new Error("Actor not found");
  }
  if (actor.access_policy === params.accessPolicy) {
    return actor;
  }

  const result = await transaction(async (client) => {
    const nextActor = await executeTakeFirst(
      client,
      db
        .updateTable("actors")
        .set({
          access_policy: params.accessPolicy,
          updated_at: sql`NOW()`,
        })
        .where("id", "=", params.actorId)
        .returning(["id", "workspace_id", "access_policy"]),
    );
    if (!nextActor) {
      throw new Error("Actor not found");
    }

    const operation =
      params.accessPolicy === "workspace_open" ? touchRelation : deleteRelation;
    const authzEntryIds = await queueAuthzRelationships(
      client,
      [
        operation(
          "actor",
          params.actorId,
          "discover_workspace",
          "workspace",
          params.workspaceId,
        ),
        operation(
          "actor",
          params.actorId,
          "invoke_workspace",
          "workspace",
          params.workspaceId,
        ),
        operation(
          "actor",
          params.actorId,
          "receive_workspace",
          "workspace",
          params.workspaceId,
        ),
      ],
      {
        source: "relationship.actor_access_policy",
        workspaceId: params.workspaceId,
        actorId: params.actorId,
        accessPolicy: params.accessPolicy,
        updatedBy: params.updatedBy,
      },
    );

    return {
      actor: nextActor,
      authzEntryIds,
    };
  });

  await flushAuthzEntries(
    result.authzEntryIds,
    "relationship.actor_access_policy",
  );

  return result.actor;
}

async function grantActorAccess(params: {
  workspaceId: string;
  actorId: string;
  requesterUserId: string;
  grantedBy: string;
}) {
  const workspaceUserContextId = buildWorkspaceUserContextId(
    params.workspaceId,
    params.requesterUserId,
  );
  const entryIds = await enqueueAuthzRelationships(
    [
      ...touchWorkspaceUserContext(params.workspaceId, params.requesterUserId),
      touchRelation(
        "actor",
        params.actorId,
        "discover_workspace_user",
        "workspace_user",
        workspaceUserContextId,
      ),
      touchRelation(
        "actor",
        params.actorId,
        "invoke_workspace_user",
        "workspace_user",
        workspaceUserContextId,
      ),
      touchRelation(
        "actor",
        params.actorId,
        "receive_workspace_user",
        "workspace_user",
        workspaceUserContextId,
      ),
    ],
    {
      source: "relationship.actor_access_grant",
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      requesterUserId: params.requesterUserId,
      grantedBy: params.grantedBy,
    },
  );
  await flushAuthzEntries(entryIds, "relationship.actor_access_grant");
}

async function ensureFriendEntry(params: {
  workspaceId: string;
  ownerUserId: string;
  peerType: ContactTargetType;
  peerWorkspaceId: string;
  peerUserId?: string;
  peerActorId?: string;
  sourceRequestId?: string;
}) {
  await db
    .insertInto("workspace_friend_entries")
    .values({
      workspace_id: params.workspaceId,
      owner_user_id: params.ownerUserId,
      peer_type: params.peerType,
      peer_workspace_id: params.peerWorkspaceId,
      peer_user_id: params.peerType === "user" ? params.peerUserId || null : null,
      peer_actor_id: params.peerType === "actor" ? params.peerActorId || null : null,
      source_request_id: params.sourceRequestId || null,
      metadata: {} as TableInsert<"workspace_friend_entries">["metadata"],
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

async function findExistingFriendEntry(params: {
  workspaceId: string;
  ownerUserId: string;
  peerType: ContactTargetType;
  peerWorkspaceId?: string;
  peerUserId?: string;
  peerActorId?: string;
}) {
  let queryBuilder = db
    .selectFrom("workspace_friend_entries")
    .selectAll()
    .where("workspace_id", "=", params.workspaceId)
    .where("owner_user_id", "=", params.ownerUserId)
    .where("peer_type", "=", params.peerType);
  queryBuilder =
    params.peerType === "user"
      ? queryBuilder
          .where("peer_workspace_id", "=", params.peerWorkspaceId || null)
          .where("peer_user_id", "=", params.peerUserId || null)
      : queryBuilder.where("peer_actor_id", "=", params.peerActorId || null);
  return queryBuilder.executeTakeFirst();
}

async function findPendingFriendRequest(params: {
  requesterWorkspaceId: string;
  requesterUserId: string;
  targetWorkspaceId: string;
  targetType: ContactTargetType;
  targetUserId?: string;
  targetActorId?: string;
}) {
  let queryBuilder = db
    .selectFrom("workspace_friend_requests")
    .selectAll()
    .where("requester_workspace_id", "=", params.requesterWorkspaceId)
    .where("requester_user_id", "=", params.requesterUserId)
    .where("target_workspace_id", "=", params.targetWorkspaceId)
    .where("target_subject_type", "=", params.targetType)
    .where("status", "=", "pending");
  queryBuilder =
    params.targetType === "user"
      ? queryBuilder.where("target_user_id", "=", params.targetUserId || null)
      : queryBuilder.where("target_actor_id", "=", params.targetActorId || null);
  return queryBuilder.executeTakeFirst();
}

async function createFriendRequest(params: {
  requesterWorkspaceId: string;
  requesterUserId: string;
  targetWorkspaceId: string;
  targetType: ContactTargetType;
  targetUserId?: string;
  targetActorId?: string;
  profileId?: string;
}) {
  const existing = await findPendingFriendRequest(params);
  if (existing) {
    return { request: existing, created: false as const };
  }
  try {
    const created = await db
      .insertInto("workspace_friend_requests")
      .values({
        requester_workspace_id: params.requesterWorkspaceId,
        requester_user_id: params.requesterUserId,
        target_workspace_id: params.targetWorkspaceId,
        target_subject_type: params.targetType,
        target_user_id: params.targetType === "user" ? params.targetUserId || null : null,
        target_actor_id: params.targetType === "actor" ? params.targetActorId || null : null,
        requested_via_profile_id: params.profileId || null,
        status: "pending",
        metadata: {} as TableInsert<"workspace_friend_requests">["metadata"],
      })
      .returningAll()
      .executeTakeFirst();
    if (!created) {
      throw new Error("Failed to create friend request");
    }
    return { request: created, created: true as const };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const retry = await findPendingFriendRequest(params);
    if (!retry) throw error;
    return { request: retry, created: false as const };
  }
}

async function createActorAccessRequest(params: {
  workspaceId: string;
  actorId: string;
  requesterUserId: string;
}) {
  const existing = await db
    .selectFrom("actor_access_requests")
    .selectAll()
    .where("workspace_id", "=", params.workspaceId)
    .where("actor_id", "=", params.actorId)
    .where("requester_user_id", "=", params.requesterUserId)
    .where("status", "=", "pending")
    .executeTakeFirst();
  if (existing) {
    return { request: existing, created: false as const };
  }

  try {
    const created = await db
      .insertInto("actor_access_requests")
      .values({
        workspace_id: params.workspaceId,
        actor_id: params.actorId,
        requester_user_id: params.requesterUserId,
        status: "pending",
        metadata: {} as TableInsert<"actor_access_requests">["metadata"],
      })
      .returningAll()
      .executeTakeFirst();
    if (!created) {
      throw new Error("Failed to create actor access request");
    }
    return { request: created, created: true as const };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const retry = await db
      .selectFrom("actor_access_requests")
      .selectAll()
      .where("workspace_id", "=", params.workspaceId)
      .where("actor_id", "=", params.actorId)
      .where("requester_user_id", "=", params.requesterUserId)
      .where("status", "=", "pending")
      .executeTakeFirst();
    if (!retry) throw error;
    return { request: retry, created: false as const };
  }
}

async function loadViewerDirectConversationMap(workspaceMemberId: string) {
  const rows = await db
    .selectFrom("direct_conversation_bindings")
    .selectAll()
    .where((eb) =>
      eb.or([
        eb.and([
          eb("participant_one_kind", "=", "user"),
          eb("participant_one_workspace_member_id", "=", workspaceMemberId),
        ]),
        eb.and([
          eb("participant_two_kind", "=", "user"),
          eb("participant_two_workspace_member_id", "=", workspaceMemberId),
        ]),
      ]),
    )
    .execute();

  const viewerIdentity: DirectConversationIdentity = {
    kind: "user",
    workspaceMemberId,
  };
  const map = new Map<string, string>();
  for (const row of rows) {
    const peer = directConversationBindingPeer(
      row as any,
      viewerIdentity,
    );
    if (!peer) continue;
    map.set(directConversationIdentityKey(peer), row.conversation_id);
  }
  return map;
}

async function findDirectConversationId(
  left: DirectConversationIdentity,
  right: DirectConversationIdentity,
) {
  const pair = canonicalizeDirectConversationPair(left, right);
  const values = directConversationBindingValues(pair);
  const row = await db
    .selectFrom("direct_conversation_bindings")
    .select(["conversation_id"])
    .where("participant_one_kind", "=", values.participant_one_kind)
    .where(
      "participant_one_workspace_member_id",
      "=",
      values.participant_one_workspace_member_id,
    )
    .where("participant_one_actor_id", "=", values.participant_one_actor_id)
    .where("participant_two_kind", "=", values.participant_two_kind)
    .where(
      "participant_two_workspace_member_id",
      "=",
      values.participant_two_workspace_member_id,
    )
    .where("participant_two_actor_id", "=", values.participant_two_actor_id)
    .executeTakeFirst();
  return row?.conversation_id || null;
}

async function getActorAccessState(params: {
  workspaceId: string;
  userId: string;
  actor: ActorSummary;
  conversationId?: string;
  pendingRequestActorIds: Set<string>;
}) {
  if (params.conversationId) return "existing" as const;
  const canInvoke = await authorizeAction({
    subject: userSubject(params.userId),
    action: "actor.invoke",
    resourceId: params.actor.actorId,
  });
  if (canInvoke || params.actor.accessPolicy === "workspace_open") {
    return "available" as const;
  }
  if (params.pendingRequestActorIds.has(params.actor.actorId)) {
    return "pending_approval" as const;
  }
  return "approval_required" as const;
}

async function resolveContactReference(params: {
  workspaceId: string;
  userId: string;
  contactKind: ContactHubKind;
  contactId: string;
}) {
  if (params.contactKind === "workspace-user") {
    const user = await getWorkspaceUserSummary(params.workspaceId, params.contactId);
    if (!user) {
      throw new Error("Workspace user not found");
    }
    if (user.userId === params.userId) {
      throw new Error("Cannot open a direct conversation with yourself");
    }
    return {
      kind: params.contactKind,
      user,
      peerIdentity: {
        kind: "user" as const,
        workspaceMemberId: user.workspaceMemberId,
      },
    };
  }

  if (params.contactKind === "workspace-actor") {
    const actor = await getActorSummary(params.contactId);
    if (!actor || actor.workspace.id !== params.workspaceId) {
      throw new Error("Actor not found");
    }
    return {
      kind: params.contactKind,
      actor,
      peerIdentity: {
        kind: "actor" as const,
        actorId: actor.actorId,
      },
    };
  }

  const friendEntry = await db
    .selectFrom("workspace_friend_entries")
    .selectAll()
    .where("workspace_id", "=", params.workspaceId)
    .where("owner_user_id", "=", params.userId)
    .where("id", "=", params.contactId)
    .executeTakeFirst();
  if (!friendEntry) {
    throw new Error("Friend not found");
  }

  if (params.contactKind === "friend-user") {
    if (!friendEntry.peer_user_id) {
      throw new Error("Friend not found");
    }
    const user = await getWorkspaceUserSummary(
      friendEntry.peer_workspace_id,
      friendEntry.peer_user_id,
    );
    if (!user) {
      throw new Error("Friend not found");
    }
    return {
      kind: params.contactKind,
      friendEntry,
      user,
      peerIdentity: {
        kind: "user" as const,
        workspaceMemberId: user.workspaceMemberId,
      },
    };
  }

  if (!friendEntry.peer_actor_id) {
    throw new Error("Friend not found");
  }
  const actor = await getActorSummary(friendEntry.peer_actor_id);
  if (!actor) {
    throw new Error("Friend not found");
  }
  return {
    kind: params.contactKind,
    friendEntry,
    actor,
    peerIdentity: {
      kind: "actor" as const,
      actorId: actor.actorId,
    },
  };
}

async function buildContactHubEntryMap(params: {
  workspaceId: string;
  userId: string;
}) {
  const viewerWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId,
  );
  const directConversationMap = viewerWorkspaceMember
    ? await loadViewerDirectConversationMap(
        viewerWorkspaceMember.workspaceMemberId,
      )
    : new Map<string, string>();
  const [members, actors, friendEntries, pendingActorAccessRows] =
    await Promise.all([
      db
        .selectFrom("workspace_members as wm")
        .innerJoin("users as u", "u.id", "wm.user_id")
        .innerJoin("workspaces as w", "w.id", "wm.workspace_id")
        .select([
          "wm.id as workspace_member_id",
          "wm.workspace_id",
          "w.name as workspace_name",
          "w.slug as workspace_slug",
          "wm.user_id",
          "wm.trust_level",
          "u.name",
          "u.email",
          "u.avatar_file_id",
        ])
        .where("wm.workspace_id", "=", params.workspaceId)
        .where("wm.user_id", "<>", params.userId)
        .orderBy("u.name", "asc")
        .execute(),
      db
        .selectFrom("actors as a")
        .innerJoin("workspaces as w", "w.id", "a.workspace_id")
        .leftJoin("files as avatar_file", "avatar_file.id", "a.avatar_file_id")
        .select([
          "a.id as actor_id",
          "a.workspace_id",
          "w.name as workspace_name",
          "w.slug as workspace_slug",
          "a.name",
          "a.title",
          "a.role",
          "a.access_policy",
          "a.avatar_emoji",
          "avatar_file.stored_name as avatar_stored_name",
        ])
        .where("a.workspace_id", "=", params.workspaceId)
        .where("a.is_active", "=", true)
        .orderBy("a.name", "asc")
        .execute(),
      db
        .selectFrom("workspace_friend_entries")
        .selectAll()
        .where("workspace_id", "=", params.workspaceId)
        .where("owner_user_id", "=", params.userId)
        .orderBy("created_at", "desc")
        .execute(),
      db
        .selectFrom("actor_access_requests")
        .select(["actor_id"])
        .where("workspace_id", "=", params.workspaceId)
        .where("requester_user_id", "=", params.userId)
        .where("status", "=", "pending")
        .execute(),
    ]);

  const pendingActorAccessIds = new Set(
    pendingActorAccessRows.map((row) => row.actor_id),
  );

  const workspaceUsers = members.map((row) =>
    mapWorkspaceUserEntry({
      user: {
        workspace: workspaceSummary(row),
        workspaceMemberId: row.workspace_member_id,
        userId: row.user_id,
        trustLevel: row.trust_level,
        name: row.name,
        email: row.email,
        avatarFileId: row.avatar_file_id,
      },
      conversationId: directConversationMap.get(
        directConversationIdentityKey({
          kind: "user",
          workspaceMemberId: row.workspace_member_id,
        }),
      ),
    }),
  );

  const workspaceActors: ContactHubEntry[] = [];
  for (const row of actors) {
    const actor: ActorSummary = {
      workspace: workspaceSummary(row),
      actorId: row.actor_id,
      name: row.name,
      title: row.title,
      role: row.role,
      avatarStoredName: row.avatar_stored_name,
      avatarEmoji: row.avatar_emoji,
      accessPolicy: row.access_policy as AccessPolicy,
    };
    const conversationId = directConversationMap.get(
      directConversationIdentityKey({
        kind: "actor",
        actorId: actor.actorId,
      }),
    );
    const accessState = await getActorAccessState({
      workspaceId: params.workspaceId,
      userId: params.userId,
      actor,
      conversationId,
      pendingRequestActorIds: pendingActorAccessIds,
    });
    workspaceActors.push(
      mapWorkspaceActorEntry({
        actor,
        conversationId,
        accessState,
      }),
    );
  }

  const friends: ContactHubEntry[] = [];
  for (const entry of friendEntries) {
    if (entry.peer_type === "user" && entry.peer_user_id) {
      const peer = await getWorkspaceUserSummary(
        entry.peer_workspace_id,
        entry.peer_user_id,
      );
      if (!peer) continue;
      friends.push(
        mapUserFriendEntry({
          entryId: entry.id,
          peer,
          conversationId: directConversationMap.get(
            directConversationIdentityKey({
              kind: "user",
              workspaceMemberId: peer.workspaceMemberId,
            }),
          ),
        }),
      );
      continue;
    }
    if (entry.peer_type === "actor" && entry.peer_actor_id) {
      const actor = await getActorSummary(entry.peer_actor_id);
      if (!actor) continue;
      friends.push(
        mapActorFriendEntry({
          entryId: entry.id,
          actor,
          conversationId: directConversationMap.get(
            directConversationIdentityKey({
              kind: "actor",
              actorId: entry.peer_actor_id,
            }),
          ),
        }),
      );
    }
  }

  return {
    workspaceUsers,
    workspaceActors,
    friends,
  };
}

async function createOrApproveFriendship(params: {
  requesterWorkspaceId: string;
  requesterUserId: string;
  targetWorkspaceId: string;
  targetType: ContactTargetType;
  targetUserId?: string;
  targetActorId?: string;
  sourceRequestId?: string;
}) {
  await ensureFriendEntry({
    workspaceId: params.requesterWorkspaceId,
    ownerUserId: params.requesterUserId,
    peerType: params.targetType,
    peerWorkspaceId: params.targetWorkspaceId,
    peerUserId: params.targetUserId,
    peerActorId: params.targetActorId,
    sourceRequestId: params.sourceRequestId,
  });

  if (params.targetType === "user" && params.targetUserId) {
    await ensureFriendEntry({
      workspaceId: params.targetWorkspaceId,
      ownerUserId: params.targetUserId,
      peerType: "user",
      peerWorkspaceId: params.requesterWorkspaceId,
      peerUserId: params.requesterUserId,
      sourceRequestId: params.sourceRequestId,
    });
  }
}

async function resolveUserRelationshipProfile(params: {
  workspaceId: string;
  userId: string;
  profile: {
    id: string;
    workspace_id: string;
    subject_type: string;
    subject_user_id: string | null;
    approval_mode: ApprovalMode;
  };
}) {
  if (params.profile.subject_user_id === params.userId) {
    return { outcome: "self_scan" as const };
  }

  if (params.profile.workspace_id === params.workspaceId) {
    return {
      outcome: "same_workspace_user" as const,
      contact: {
        kind: "workspace-user" as const,
        id: params.profile.subject_user_id!,
      },
    };
  }

  const existingFriend = await findExistingFriendEntry({
    workspaceId: params.workspaceId,
    ownerUserId: params.userId,
    peerType: "user",
    peerWorkspaceId: params.profile.workspace_id,
    peerUserId: params.profile.subject_user_id || undefined,
  });
  if (existingFriend) {
    return {
      outcome: "friend_active" as const,
      contact: {
        kind: "friend-user" as const,
        id: existingFriend.id,
      },
    };
  }

  if (params.profile.approval_mode === "auto") {
    await createOrApproveFriendship({
      requesterWorkspaceId: params.workspaceId,
      requesterUserId: params.userId,
      targetWorkspaceId: params.profile.workspace_id,
      targetType: "user",
      targetUserId: params.profile.subject_user_id || undefined,
    });
    const entry = await findExistingFriendEntry({
      workspaceId: params.workspaceId,
      ownerUserId: params.userId,
      peerType: "user",
      peerWorkspaceId: params.profile.workspace_id,
      peerUserId: params.profile.subject_user_id || undefined,
    });
    return {
      outcome: "friend_active" as const,
      contact: entry
        ? {
            kind: "friend-user" as const,
            id: entry.id,
          }
        : undefined,
    };
  }

  const requestResult = await createFriendRequest({
    requesterWorkspaceId: params.workspaceId,
    requesterUserId: params.userId,
    targetWorkspaceId: params.profile.workspace_id,
    targetType: "user",
    targetUserId: params.profile.subject_user_id || undefined,
    profileId: params.profile.id,
  });
  return {
    outcome: requestResult.created
      ? ("friend_request_created" as const)
      : ("friend_request_pending" as const),
    requestId: requestResult.request.id,
  };
}

export async function getUserFriendSearchProfile(params: { userId: string }) {
  const row = await getUserFriendSearchProfileRow(params.userId);
  return {
    friendId: row.friend_search_id,
    searchByIdEnabled: row.friend_search_enabled,
  };
}

export async function updateUserFriendSearchProfile(params: {
  userId: string;
  friendId?: string;
  searchByIdEnabled?: boolean;
}) {
  const current = await getUserFriendSearchProfileRow(params.userId);
  const nextFriendId =
    typeof params.friendId === "string"
      ? validateFriendSearchId(params.friendId)
      : current.friend_search_id;
  const nextSearchByIdEnabled =
    typeof params.searchByIdEnabled === "boolean"
      ? params.searchByIdEnabled
      : current.friend_search_enabled;

  try {
    const updated = await db
      .updateTable("users")
      .set({
        friend_search_id: nextFriendId,
        friend_search_enabled: nextSearchByIdEnabled,
        updated_at: sql`NOW()`,
      })
      .where("id", "=", params.userId)
      .returning(["friend_search_id", "friend_search_enabled"])
      .executeTakeFirst();
    if (!updated) {
      throw new Error("Failed to update friend search profile");
    }
    return {
      friendId: updated.friend_search_id,
      searchByIdEnabled: updated.friend_search_enabled,
    };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new Error("This friend ID is already taken.");
    }
    throw error;
  }
}

export async function searchUsersByFriendId(params: {
  workspaceId: string;
  userId: string;
  query: string;
}) {
  const normalizedQuery = normalizeFriendSearchId(params.query);
  if (!normalizedQuery) {
    return {
      query: normalizedQuery,
      outcome: "empty" as FriendSearchOutcome,
      matches: [],
    };
  }
  if (!FRIEND_SEARCH_ID_PATTERN.test(normalizedQuery)) {
    return {
      query: normalizedQuery,
      outcome: "invalid" as FriendSearchOutcome,
      matches: [],
    };
  }

  const targetUser = await db
    .selectFrom("users")
    .select(["id", "friend_search_id", "friend_search_enabled"])
    .where("friend_search_id", "=", normalizedQuery)
    .executeTakeFirst();
  if (!targetUser || !targetUser.friend_search_enabled) {
    return {
      query: normalizedQuery,
      outcome: "not_found" as FriendSearchOutcome,
      matches: [],
    };
  }
  if (targetUser.id === params.userId) {
    return {
      query: normalizedQuery,
      outcome: "self" as FriendSearchOutcome,
      matches: [],
    };
  }

  const memberships = await db
    .selectFrom("workspace_members as wm")
    .innerJoin("users as u", "u.id", "wm.user_id")
    .innerJoin("workspaces as w", "w.id", "wm.workspace_id")
    .select([
      "wm.id as workspace_member_id",
      "wm.workspace_id",
      "w.name as workspace_name",
      "w.slug as workspace_slug",
      "wm.user_id",
      "wm.trust_level",
      "u.name",
      "u.email",
      "u.avatar_file_id",
    ])
    .where("wm.user_id", "=", targetUser.id)
    .orderBy(
      sql<number>`CASE WHEN wm.workspace_id = ${params.workspaceId} THEN 0 ELSE 1 END`,
    )
    .orderBy("w.name", "asc")
    .execute();
  if (memberships.length === 0) {
    return {
      query: normalizedQuery,
      outcome: "not_found" as FriendSearchOutcome,
      matches: [],
    };
  }

  const viewerWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId,
  );
  const directConversationMap = viewerWorkspaceMember
    ? await loadViewerDirectConversationMap(
        viewerWorkspaceMember.workspaceMemberId,
      )
    : new Map<string, string>();
  const matches = [];

  for (const row of memberships) {
    const peer: UserWorkspaceSummary = {
      workspace: workspaceSummary(row),
      workspaceMemberId: row.workspace_member_id,
      userId: row.user_id,
      trustLevel: row.trust_level,
      name: row.name,
      email: row.email,
      avatarFileId: row.avatar_file_id,
    };
    const profile = await ensureRelationshipProfile({
      workspaceId: row.workspace_id,
      createdBy: row.user_id,
      subjectType: "user",
      subjectUserId: row.user_id,
    });
    const conversationId = directConversationMap.get(
      directConversationIdentityKey({
        kind: "user",
        workspaceMemberId: row.workspace_member_id,
      }),
    );

    if (row.workspace_id === params.workspaceId) {
      matches.push({
        profileId: profile.id,
        title: peer.name || peer.email || "Unknown user",
        subtitle: `${peer.workspace.name} · ${peer.email}`,
        avatarUrl: peer.avatarFileId
          ? getFileUrlById(peer.avatarFileId)
          : undefined,
        workspace: peer.workspace,
        userId: peer.userId,
        state: "same_workspace_user" as FriendSearchMatchState,
        contact: {
          kind: "workspace-user" as const,
          id: peer.userId,
        },
        conversationId,
      });
      continue;
    }

    const existingFriend = await findExistingFriendEntry({
      workspaceId: params.workspaceId,
      ownerUserId: params.userId,
      peerType: "user",
      peerWorkspaceId: row.workspace_id,
      peerUserId: row.user_id,
    });
    if (existingFriend) {
      matches.push({
        profileId: profile.id,
        title: peer.name || peer.email || "Unknown user",
        subtitle: `${peer.workspace.name} · ${peer.email}`,
        avatarUrl: peer.avatarFileId
          ? getFileUrlById(peer.avatarFileId)
          : undefined,
        workspace: peer.workspace,
        userId: peer.userId,
        state: "friend" as FriendSearchMatchState,
        contact: {
          kind: "friend-user" as const,
          id: existingFriend.id,
        },
        conversationId,
      });
      continue;
    }

    const pendingRequest = await findPendingFriendRequest({
      requesterWorkspaceId: params.workspaceId,
      requesterUserId: params.userId,
      targetWorkspaceId: row.workspace_id,
      targetType: "user",
      targetUserId: row.user_id,
    });
    matches.push({
      profileId: profile.id,
      title: peer.name || peer.email || "Unknown user",
      subtitle: `${peer.workspace.name} · ${peer.email}`,
      avatarUrl: peer.avatarFileId
        ? getFileUrlById(peer.avatarFileId)
        : undefined,
      workspace: peer.workspace,
      userId: peer.userId,
      state: pendingRequest
        ? ("pending_request" as FriendSearchMatchState)
        : ("requestable" as FriendSearchMatchState),
      requestId: pendingRequest?.id,
    });
  }

  return {
    query: normalizedQuery,
    outcome: matches.length > 0 ? ("found" as FriendSearchOutcome) : ("not_found" as FriendSearchOutcome),
    matches,
  };
}

export async function requestFriendBySearchProfile(params: {
  workspaceId: string;
  userId: string;
  profileId: string;
}) {
  const profile = await db
    .selectFrom("workspace_relationship_profiles")
    .selectAll()
    .where("id", "=", params.profileId)
    .where("subject_type", "=", "user")
    .executeTakeFirst();
  if (!profile) {
    throw new Error("Search target not found");
  }

  const targetUser = await db
    .selectFrom("users")
    .select(["id", "friend_search_enabled"])
    .where("id", "=", profile.subject_user_id!)
    .executeTakeFirst();
  if (!targetUser?.friend_search_enabled) {
    throw new Error("This user cannot be added by friend ID.");
  }

  return resolveUserRelationshipProfile({
    workspaceId: params.workspaceId,
    userId: params.userId,
    profile: {
      id: profile.id,
      workspace_id: profile.workspace_id,
      subject_type: profile.subject_type,
      subject_user_id: profile.subject_user_id,
      approval_mode: profile.approval_mode as ApprovalMode,
    },
  });
}

export async function getUserRelationshipProfile(params: {
  workspaceId: string;
  userId: string;
}) {
  const profile = await ensureRelationshipProfile({
    workspaceId: params.workspaceId,
    createdBy: params.userId,
    subjectType: "user",
    subjectUserId: params.userId,
  });
  return {
    subjectType: "user" as const,
    approvalMode: profile.approval_mode,
    qrToken: profile.qr_token,
    qrUrl: buildRelationshipQrUrl(profile.qr_token),
  };
}

export async function updateUserRelationshipProfile(params: {
  workspaceId: string;
  userId: string;
  approvalMode: ApprovalMode;
}) {
  const profile = await ensureRelationshipProfile({
    workspaceId: params.workspaceId,
    createdBy: params.userId,
    subjectType: "user",
    subjectUserId: params.userId,
  });
  const updated = await db
    .updateTable("workspace_relationship_profiles")
    .set({
      approval_mode: params.approvalMode,
      updated_at: sql`NOW()`,
    })
    .where("id", "=", profile.id)
    .returningAll()
    .executeTakeFirst();
  if (!updated) {
    throw new Error("Failed to update relationship profile");
  }
  return {
    subjectType: "user" as const,
    approvalMode: updated.approval_mode,
    qrToken: updated.qr_token,
    qrUrl: buildRelationshipQrUrl(updated.qr_token),
  };
}

export async function getActorRelationshipProfile(params: {
  workspaceId: string;
  actorId: string;
  userId: string;
}) {
  const actor = await getActorSummary(params.actorId);
  if (!actor || actor.workspace.id !== params.workspaceId) {
    throw new Error("Actor not found");
  }
  const profile = await ensureRelationshipProfile({
    workspaceId: params.workspaceId,
    createdBy: params.userId,
    subjectType: "actor",
    subjectActorId: params.actorId,
  });
  return {
    subjectType: "actor" as const,
    approvalMode: profile.approval_mode,
    qrToken: profile.qr_token,
    qrUrl: buildRelationshipQrUrl(profile.qr_token),
    accessPolicy: actor.accessPolicy,
  };
}

export async function updateActorRelationshipProfile(params: {
  workspaceId: string;
  actorId: string;
  userId: string;
  approvalMode: ApprovalMode;
  accessPolicy?: AccessPolicy;
}) {
  const profile = await ensureRelationshipProfile({
    workspaceId: params.workspaceId,
    createdBy: params.userId,
    subjectType: "actor",
    subjectActorId: params.actorId,
  });

  const updatedProfile = await db
    .updateTable("workspace_relationship_profiles")
    .set({
      approval_mode: params.approvalMode,
      updated_at: sql`NOW()`,
    })
    .where("id", "=", profile.id)
    .returningAll()
    .executeTakeFirst();
  if (!updatedProfile) {
    throw new Error("Failed to update relationship profile");
  }

  let accessPolicy = (await getActorSummary(params.actorId))?.accessPolicy;
  if (params.accessPolicy) {
    const actor = await updateActorAccessPolicy({
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      updatedBy: params.userId,
      accessPolicy: params.accessPolicy,
    });
    accessPolicy = actor.access_policy as AccessPolicy;
  }

  return {
    subjectType: "actor" as const,
    approvalMode: updatedProfile.approval_mode,
    qrToken: updatedProfile.qr_token,
    qrUrl: buildRelationshipQrUrl(updatedProfile.qr_token),
    accessPolicy: accessPolicy || "workspace_open",
  };
}

export async function scanRelationshipQr(params: {
  workspaceId: string;
  userId: string;
  token: string;
}) {
  const profile = await db
    .selectFrom("workspace_relationship_profiles")
    .selectAll()
    .where("qr_token", "=", params.token)
    .executeTakeFirst();
  if (!profile) {
    throw new Error("Relationship QR code not found");
  }

  if (
    profile.subject_type === "user" &&
    profile.subject_user_id === params.userId
  ) {
    return { outcome: "self_scan" as const };
  }

  if (profile.subject_type === "user") {
    return resolveUserRelationshipProfile({
      workspaceId: params.workspaceId,
      userId: params.userId,
      profile: {
        id: profile.id,
        workspace_id: profile.workspace_id,
        subject_type: profile.subject_type,
        subject_user_id: profile.subject_user_id,
        approval_mode: profile.approval_mode as ApprovalMode,
      },
    });
  }

  if (
    profile.subject_type === "actor" &&
    profile.workspace_id === params.workspaceId
  ) {
    const actor = await getActorSummary(profile.subject_actor_id!);
    if (!actor) {
      throw new Error("Actor not found");
    }
    const canInvoke = await authorizeAction({
      subject: userSubject(params.userId),
      action: "actor.invoke",
      resourceId: actor.actorId,
    });

    if (canInvoke || actor.accessPolicy === "workspace_open") {
      return {
        outcome: "actor_access_granted" as const,
        contact: {
          kind: "workspace-actor" as const,
          id: actor.actorId,
        },
      };
    }

    if (profile.approval_mode === "auto") {
      await grantActorAccess({
        workspaceId: params.workspaceId,
        actorId: actor.actorId,
        requesterUserId: params.userId,
        grantedBy: params.userId,
      });
      return {
        outcome: "actor_access_granted" as const,
        contact: {
          kind: "workspace-actor" as const,
          id: actor.actorId,
        },
      };
    }

    const requestResult = await createActorAccessRequest({
      workspaceId: params.workspaceId,
      actorId: actor.actorId,
      requesterUserId: params.userId,
    });
    return {
      outcome: requestResult.created
        ? ("actor_access_request_created" as const)
        : ("actor_access_pending" as const),
      requestId: requestResult.request.id,
      contact: {
        kind: "workspace-actor" as const,
        id: actor.actorId,
      },
    };
  }

  const existingFriend = await findExistingFriendEntry({
    workspaceId: params.workspaceId,
    ownerUserId: params.userId,
    peerType: "actor",
    peerActorId: profile.subject_actor_id || undefined,
  });
  if (existingFriend) {
    return {
      outcome: "friend_active" as const,
      contact: {
        kind: "friend-actor" as const,
        id: existingFriend.id,
      },
    };
  }

  if (profile.approval_mode === "auto") {
    await createOrApproveFriendship({
      requesterWorkspaceId: params.workspaceId,
      requesterUserId: params.userId,
      targetWorkspaceId: profile.workspace_id,
      targetType: "actor",
      targetActorId: profile.subject_actor_id || undefined,
    });
    const entry = await findExistingFriendEntry({
      workspaceId: params.workspaceId,
      ownerUserId: params.userId,
      peerType: "actor",
      peerActorId: profile.subject_actor_id || undefined,
    });
    return {
      outcome: "friend_active" as const,
      contact: entry
        ? {
            kind: "friend-actor" as const,
            id: entry.id,
          }
        : undefined,
    };
  }

  const requestResult = await createFriendRequest({
    requesterWorkspaceId: params.workspaceId,
    requesterUserId: params.userId,
    targetWorkspaceId: profile.workspace_id,
    targetType: "actor",
    targetActorId: profile.subject_actor_id || undefined,
    profileId: profile.id,
  });
  return {
    outcome: requestResult.created
      ? ("friend_request_created" as const)
      : ("friend_request_pending" as const),
    requestId: requestResult.request.id,
  };
}

export async function listFriends(params: {
  workspaceId: string;
  userId: string;
}) {
  const entries = (await buildContactHubEntryMap(params)).friends;
  return { friends: entries };
}

export async function listFriendRequests(params: {
  workspaceId: string;
  userId: string;
}) {
  const incomingRows = await db
    .selectFrom("workspace_friend_requests")
    .selectAll()
    .where("target_workspace_id", "=", params.workspaceId)
    .where("status", "=", "pending")
    .execute();
  const outgoingRows = await db
    .selectFrom("workspace_friend_requests")
    .selectAll()
    .where("requester_workspace_id", "=", params.workspaceId)
    .where("requester_user_id", "=", params.userId)
    .where("status", "=", "pending")
    .execute();

  const incoming = [];
  for (const row of incomingRows) {
    if (row.target_subject_type === "user") {
      if (row.target_user_id !== params.userId) continue;
    } else if (row.target_actor_id) {
      const canApprove = await authorizeAction({
        subject: userSubject(params.userId),
        action: "actor.grant",
        resourceId: row.target_actor_id,
      });
      if (!canApprove) continue;
    }

    const requester = await getWorkspaceUserSummary(
      row.requester_workspace_id,
      row.requester_user_id,
    );
    const targetUser =
      row.target_subject_type === "user" && row.target_user_id
        ? await getWorkspaceUserSummary(row.target_workspace_id, row.target_user_id)
        : null;
    const targetActor =
      row.target_subject_type === "actor" && row.target_actor_id
        ? await getActorSummary(row.target_actor_id)
        : null;
    incoming.push({
      id: row.id,
      status: row.status,
      createdAt: toIsoString(row.created_at),
      requester,
      targetType: row.target_subject_type,
      targetUser,
      targetActor,
    });
  }

  const outgoing = [];
  for (const row of outgoingRows) {
    const targetUser =
      row.target_subject_type === "user" && row.target_user_id
        ? await getWorkspaceUserSummary(row.target_workspace_id, row.target_user_id)
        : null;
    const targetActor =
      row.target_subject_type === "actor" && row.target_actor_id
        ? await getActorSummary(row.target_actor_id)
        : null;
    outgoing.push({
      id: row.id,
      status: row.status,
      createdAt: toIsoString(row.created_at),
      targetType: row.target_subject_type,
      targetUser,
      targetActor,
    });
  }

  return { incoming, outgoing };
}

export async function resolveFriendRequest(params: {
  workspaceId: string;
  userId: string;
  requestId: string;
  decision: "approve" | "reject";
}) {
  const request = await db
    .selectFrom("workspace_friend_requests")
    .selectAll()
    .where("id", "=", params.requestId)
    .executeTakeFirst();
  if (!request || request.target_workspace_id !== params.workspaceId) {
    throw new Error("Friend request not found");
  }
  if (request.status !== "pending") {
    throw new Error("Friend request has already been resolved");
  }

  if (request.target_subject_type === "user") {
    if (request.target_user_id !== params.userId) {
      throw new Error("Not allowed to resolve this friend request");
    }
  } else if (request.target_actor_id) {
    const canApprove = await authorizeAction({
      subject: userSubject(params.userId),
      action: "actor.grant",
      resourceId: request.target_actor_id,
    });
    if (!canApprove) {
      throw new Error("Not allowed to resolve this friend request");
    }
  }

  if (params.decision === "approve") {
    await createOrApproveFriendship({
      requesterWorkspaceId: request.requester_workspace_id,
      requesterUserId: request.requester_user_id,
      targetWorkspaceId: request.target_workspace_id,
      targetType: request.target_subject_type as ContactTargetType,
      targetUserId: request.target_user_id || undefined,
      targetActorId: request.target_actor_id || undefined,
      sourceRequestId: request.id,
    });
  }

  const updated = await db
    .updateTable("workspace_friend_requests")
    .set({
      status: params.decision === "approve" ? "approved" : "rejected",
      resolved_by_user_id: params.userId,
      resolved_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })
    .where("id", "=", request.id)
    .returningAll()
    .executeTakeFirst();

  if (!updated) {
    throw new Error("Failed to resolve friend request");
  }

  return updated;
}

export async function listActorAccessRequests(params: {
  workspaceId: string;
  userId: string;
}) {
  const [incomingRows, outgoingRows] = await Promise.all([
    db
      .selectFrom("actor_access_requests")
      .selectAll()
      .where("workspace_id", "=", params.workspaceId)
      .where("status", "=", "pending")
      .execute(),
    db
      .selectFrom("actor_access_requests")
      .selectAll()
      .where("workspace_id", "=", params.workspaceId)
      .where("requester_user_id", "=", params.userId)
      .where("status", "=", "pending")
      .execute(),
  ]);

  const incoming = [];
  for (const row of incomingRows) {
    const canApprove = await authorizeAction({
      subject: userSubject(params.userId),
      action: "actor.grant",
      resourceId: row.actor_id,
    });
    if (!canApprove) continue;
    incoming.push({
      id: row.id,
      status: row.status,
      createdAt: toIsoString(row.created_at),
      requester: await getWorkspaceUserSummary(params.workspaceId, row.requester_user_id),
      actor: await getActorSummary(row.actor_id),
    });
  }

  const outgoing = [];
  for (const row of outgoingRows) {
    outgoing.push({
      id: row.id,
      status: row.status,
      createdAt: toIsoString(row.created_at),
      actor: await getActorSummary(row.actor_id),
    });
  }

  return { incoming, outgoing };
}

export async function resolveActorAccessRequest(params: {
  workspaceId: string;
  userId: string;
  requestId: string;
  decision: "approve" | "reject";
}) {
  const request = await db
    .selectFrom("actor_access_requests")
    .selectAll()
    .where("id", "=", params.requestId)
    .executeTakeFirst();
  if (!request || request.workspace_id !== params.workspaceId) {
    throw new Error("Actor access request not found");
  }
  if (request.status !== "pending") {
    throw new Error("Actor access request has already been resolved");
  }
  const canApprove = await authorizeAction({
    subject: userSubject(params.userId),
    action: "actor.grant",
    resourceId: request.actor_id,
  });
  if (!canApprove) {
    throw new Error("Not allowed to resolve this actor access request");
  }

  if (params.decision === "approve") {
    await grantActorAccess({
      workspaceId: params.workspaceId,
      actorId: request.actor_id,
      requesterUserId: request.requester_user_id,
      grantedBy: params.userId,
    });
  }

  const updated = await db
    .updateTable("actor_access_requests")
    .set({
      status: params.decision === "approve" ? "approved" : "rejected",
      resolved_by_user_id: params.userId,
      resolved_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })
    .where("id", "=", request.id)
    .returningAll()
    .executeTakeFirst();
  if (!updated) {
    throw new Error("Failed to resolve actor access request");
  }
  return updated;
}

export async function getContactHub(params: {
  workspaceId: string;
  userId: string;
}) {
  const viewerWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId,
  );
  const [{ incoming: friendIncoming }, { incoming: actorIncoming }, entries] =
    await Promise.all([
      listFriendRequests(params),
      listActorAccessRequests(params),
      buildContactHubEntryMap(params),
    ]);
  const threads = await getThreadsForUser({
    userId: params.userId,
    workspaceId: params.workspaceId,
  });
  const groups = await Promise.all(
    threads
      .filter((thread) => thread.kind === "group")
      .map((thread) =>
        mapConversationSummaryView(thread, {
          userId: params.userId,
          workspaceMemberId: viewerWorkspaceMember?.workspaceMemberId,
        }),
      ),
  );

  return {
    requestSummary: {
      friendPendingCount: friendIncoming.length,
      actorAccessPendingCount: actorIncoming.length,
      totalPendingCount: friendIncoming.length + actorIncoming.length,
    },
    workspaceActors: entries.workspaceActors,
    workspaceUsers: entries.workspaceUsers,
    friends: entries.friends,
    groups,
  };
}

export async function getContactHubDetail(params: {
  workspaceId: string;
  userId: string;
  contactKind: ContactHubKind;
  contactId: string;
}) {
  const hub = await getContactHub({
    workspaceId: params.workspaceId,
    userId: params.userId,
  });
  const entry = [
    ...hub.workspaceActors,
    ...hub.workspaceUsers,
    ...hub.friends,
  ].find(
    (item) => item.kind === params.contactKind && item.id === params.contactId,
  );
  if (!entry) {
    throw new Error("Contact not found");
  }

  const relatedGroups = hub.groups.filter((conversation) => {
    if (entry.actorId) {
      return conversation.members.some(
        (member) => member.type === "actor" && member.actorId === entry.actorId,
      );
    }
    if (entry.userId) {
      return conversation.members.some(
        (member) => member.type === "user" && member.userId === entry.userId,
      );
    }
    return false;
  });

  return {
    contact: entry,
    groups: relatedGroups,
  };
}

export async function openDirectConversation(params: {
  workspaceId: string;
  userId: string;
  contactKind: ContactHubKind;
  contactId: string;
}) {
  const resolved = await resolveContactReference(params);
  const requesterWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId,
  );
  if (!requesterWorkspaceMember) {
    throw new Error("Workspace member not found");
  }
  const requesterIdentity: DirectConversationIdentity = {
    kind: "user",
    workspaceMemberId: requesterWorkspaceMember.workspaceMemberId,
  };

  if (resolved.kind === "workspace-actor" && resolved.actor) {
    const canInvoke = await authorizeAction({
      subject: userSubject(params.userId),
      action: "actor.invoke",
      resourceId: resolved.actor.actorId,
    });

    if (!canInvoke && resolved.actor.accessPolicy === "approval_required") {
      const profile = await ensureRelationshipProfile({
        workspaceId: params.workspaceId,
        createdBy: params.userId,
        subjectType: "actor",
        subjectActorId: resolved.actor.actorId,
      });
      if (profile.approval_mode === "auto") {
        await grantActorAccess({
          workspaceId: params.workspaceId,
          actorId: resolved.actor.actorId,
          requesterUserId: params.userId,
          grantedBy: params.userId,
        });
      } else {
        const accessRequest = await createActorAccessRequest({
          workspaceId: params.workspaceId,
          actorId: resolved.actor.actorId,
          requesterUserId: params.userId,
        });
        return {
          status: "pending_approval" as const,
          requestId: accessRequest.request.id,
        };
      }
    }
  }

  const existingConversationId = await findDirectConversationId(
    requesterIdentity,
    resolved.peerIdentity,
  );
  if (existingConversationId) {
    return {
      status: "ready" as const,
      created: false,
      conversationId: existingConversationId,
    };
  }

  try {
    const targetWorkspaceMemberId =
      resolved.peerIdentity.kind === "user" ? resolved.user?.workspaceMemberId : undefined;
    if (resolved.peerIdentity.kind === "user" && !targetWorkspaceMemberId) {
      throw new Error("Peer workspace membership not found");
    }
    const created = await createThread({
      workspaceId: params.workspaceId,
      kind: "private",
      createdByUserId: params.userId,
      createdByWorkspaceMemberId: requesterIdentity.workspaceMemberId,
      actorIds: resolved.peerIdentity.kind === "actor" ? [resolved.peerIdentity.actorId] : [],
      workspaceMemberIds:
        targetWorkspaceMemberId ? [targetWorkspaceMemberId] : [],
      directBindingPair: canonicalizeDirectConversationPair(
        requesterIdentity,
        resolved.peerIdentity,
      ),
    });

    return {
      status: "ready" as const,
      created: true,
      conversationId: created.conversation.id as string,
    };
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    const retryConversationId = await findDirectConversationId(
      requesterIdentity,
      resolved.peerIdentity,
    );
    if (!retryConversationId) throw error;
    return {
      status: "ready" as const,
      created: false,
      conversationId: retryConversationId,
    };
  }
}
