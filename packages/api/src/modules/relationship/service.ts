import { sql } from "kysely";
import { v4 as uuidv4 } from "uuid";
import { transaction } from "../../infrastructure/database/index.js";
import {
  db,
  executeCompiledQuery,
  executeTakeFirst,
} from "../../infrastructure/database/kysely.js";
import {
  buildWorkspaceMemberContextId,
  deleteRelation,
  enqueueAuthzRelationships,
  flushAuthzOutboxEntries,
  queueAuthzRelationships,
  touchRelation,
  touchWorkspaceMemberContext,
} from "../../infrastructure/authz/index.js";
import { getFileUrl } from "../../infrastructure/storage/index.js";
import { getFileUrlById } from "../files/service.js";
import {
  authorizeAction,
  resolveWorkspaceAccessSubject,
  userSubject,
  workspaceMemberSubject,
} from "../access/service.js";
import {
  createThread,
  getThreadsForWorkspaceMember,
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
  "workspace-member",
  "friend-actor",
  "friend-member",
] as const;

export type ContactHubKind = (typeof CONTACT_HUB_KINDS)[number];

type ApprovalMode = "auto" | "manual";
type AccessPolicy = "workspace_open" | "approval_required";
type RequestStatus = "pending" | "approved" | "rejected";
type ContactTargetType = "member" | "actor";
type IdentitySearchOutcome =
  | "empty"
  | "invalid"
  | "self"
  | "not_found"
  | "found";
type IdentitySearchMatchState =
  | "same_workspace_member"
  | "friend"
  | "pending_request"
  | "requestable";

type WorkspaceSummary = {
  id: string;
  name: string;
  slug: string;
};

type WorkspaceMemberSummary = {
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
  isPublicShared: boolean;
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

const IDENTITY_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{3,31})$/;

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

function normalizeIdentityId(value: string) {
  return value.trim().toLowerCase();
}

function validateIdentityId(value: string) {
  const normalized = normalizeIdentityId(value);
  if (!IDENTITY_ID_PATTERN.test(normalized)) {
    throw new Error(
      "Identity ID must be 4-32 characters using letters, numbers, dot, underscore, or hyphen.",
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

async function getWorkspaceMemberSummaryByUser(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceMemberSummary | null> {
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

async function getWorkspaceMemberSummaryById(
  workspaceMemberId: string,
): Promise<WorkspaceMemberSummary | null> {
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
    .where("wm.id", "=", workspaceMemberId)
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

async function getMemberRelationshipProfileRow(workspaceMemberId: string) {
  const row = await db
    .selectFrom("workspace_relationship_profiles")
    .select([
      "id",
      "workspace_id",
      "identity_id",
      "identity_search_enabled",
      "approval_mode",
      "qr_token",
    ])
    .where("subject_type", "=", "member")
    .where("subject_workspace_member_id", "=", workspaceMemberId)
    .executeTakeFirst();
  if (!row) {
    throw new Error("Relationship profile not found");
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
      "a.is_public_shared",
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
    isPublicShared: Boolean(row.is_public_shared),
  };
}

function mapMemberFriendEntry(params: {
  entryId: string;
  peer: WorkspaceMemberSummary;
  conversationId?: string;
}): ContactHubEntry {
  return {
    kind: "friend-member",
    id: params.entryId,
    targetType: "member",
    title: params.peer.name || params.peer.email || "Unknown member",
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

function mapWorkspaceMemberEntry(params: {
  member: WorkspaceMemberSummary;
  conversationId?: string;
}): ContactHubEntry {
  return {
    kind: "workspace-member",
    id: params.member.workspaceMemberId,
    targetType: "member",
    title: params.member.name || params.member.email || "Unknown member",
    subtitle: `${params.member.email} · ${params.member.trustLevel || "member"}`,
    avatarUrl: params.member.avatarFileId
      ? getFileUrlById(params.member.avatarFileId)
      : undefined,
    workspace: params.member.workspace,
    workspaceMemberId: params.member.workspaceMemberId,
    userId: params.member.userId,
    relationLabel: "Workspace member",
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
  createdByWorkspaceMemberId: string;
  subjectType: ContactTargetType;
  subjectWorkspaceMemberId?: string;
  subjectActorId?: string;
}) {
  let queryBuilder = db
    .selectFrom("workspace_relationship_profiles")
    .selectAll()
    .where("workspace_id", "=", params.workspaceId)
    .where("subject_type", "=", params.subjectType);
  queryBuilder =
    params.subjectType === "member"
      ? queryBuilder.where(
          "subject_workspace_member_id",
          "=",
          params.subjectWorkspaceMemberId || null,
        )
      : queryBuilder.where("subject_actor_id", "=", params.subjectActorId || null);
  const existing = await queryBuilder.executeTakeFirst();
  if (existing) return existing;

  const inserted = await db
    .insertInto("workspace_relationship_profiles")
    .values({
      workspace_id: params.workspaceId,
      subject_type: params.subjectType,
      subject_workspace_member_id:
        params.subjectType === "member"
          ? params.subjectWorkspaceMemberId || null
          : null,
      subject_actor_id: params.subjectType === "actor" ? params.subjectActorId || null : null,
      qr_token: uuidv4(),
      created_by_workspace_member_id: params.createdByWorkspaceMemberId,
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
  updatedByWorkspaceMemberId: string;
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
        updatedByWorkspaceMemberId: params.updatedByWorkspaceMemberId,
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
  requesterWorkspaceMemberId: string;
  grantedByWorkspaceMemberId: string;
}) {
  const requester = await getWorkspaceMemberSummaryById(
    params.requesterWorkspaceMemberId,
  );
  if (!requester || requester.workspace.id !== params.workspaceId) {
    throw new Error("Workspace member not found");
  }
  const workspaceMemberContextId = buildWorkspaceMemberContextId(
    requester.workspaceMemberId,
  );
  const entryIds = await enqueueAuthzRelationships(
    [
      ...touchWorkspaceMemberContext({
        workspaceMemberId: requester.workspaceMemberId,
        workspaceId: params.workspaceId,
        userId: requester.userId,
      }),
      touchRelation(
        "actor",
        params.actorId,
        "discover_workspace_member",
        "workspace_member",
        workspaceMemberContextId,
      ),
      touchRelation(
        "actor",
        params.actorId,
        "invoke_workspace_member",
        "workspace_member",
        workspaceMemberContextId,
      ),
      touchRelation(
        "actor",
        params.actorId,
        "receive_workspace_member",
        "workspace_member",
        workspaceMemberContextId,
      ),
    ],
    {
      source: "relationship.actor_access_grant",
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      requesterWorkspaceMemberId: params.requesterWorkspaceMemberId,
      grantedByWorkspaceMemberId: params.grantedByWorkspaceMemberId,
    },
  );
  await flushAuthzEntries(entryIds, "relationship.actor_access_grant");
}

async function ensureFriendEntry(params: {
  workspaceId: string;
  ownerWorkspaceMemberId: string;
  peerType: ContactTargetType;
  peerWorkspaceMemberId?: string;
  peerActorId?: string;
  sourceRequestId?: string;
}) {
  await db
    .insertInto("workspace_friend_entries")
    .values({
      workspace_id: params.workspaceId,
      owner_workspace_member_id: params.ownerWorkspaceMemberId,
      peer_type: params.peerType,
      peer_workspace_member_id:
        params.peerType === "member"
          ? params.peerWorkspaceMemberId || null
          : null,
      peer_actor_id: params.peerType === "actor" ? params.peerActorId || null : null,
      source_request_id: params.sourceRequestId || null,
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

async function findExistingFriendEntry(params: {
  workspaceId: string;
  ownerWorkspaceMemberId: string;
  peerType: ContactTargetType;
  peerWorkspaceMemberId?: string;
  peerActorId?: string;
}) {
  let queryBuilder = db
    .selectFrom("workspace_friend_entries")
    .selectAll()
    .where("workspace_id", "=", params.workspaceId)
    .where("owner_workspace_member_id", "=", params.ownerWorkspaceMemberId)
    .where("peer_type", "=", params.peerType);
  queryBuilder =
    params.peerType === "member"
      ? queryBuilder.where(
          "peer_workspace_member_id",
          "=",
          params.peerWorkspaceMemberId || null,
        )
      : queryBuilder.where("peer_actor_id", "=", params.peerActorId || null);
  return queryBuilder.executeTakeFirst();
}

async function findPendingFriendRequest(params: {
  requesterWorkspaceMemberId: string;
  targetType: ContactTargetType;
  targetWorkspaceMemberId?: string;
  targetActorId?: string;
}) {
  let queryBuilder = db
    .selectFrom("workspace_friend_requests")
    .selectAll()
    .where(
      "requester_workspace_member_id",
      "=",
      params.requesterWorkspaceMemberId,
    )
    .where("target_subject_type", "=", params.targetType)
    .where("status", "=", "pending");
  queryBuilder =
    params.targetType === "member"
      ? queryBuilder.where(
          "target_workspace_member_id",
          "=",
          params.targetWorkspaceMemberId || null,
        )
      : queryBuilder.where("target_actor_id", "=", params.targetActorId || null);
  return queryBuilder.executeTakeFirst();
}

async function createFriendRequest(params: {
  requesterWorkspaceMemberId: string;
  targetType: ContactTargetType;
  targetWorkspaceMemberId?: string;
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
        requester_workspace_member_id: params.requesterWorkspaceMemberId,
        target_subject_type: params.targetType,
        target_workspace_member_id:
          params.targetType === "member"
            ? params.targetWorkspaceMemberId || null
            : null,
        target_actor_id: params.targetType === "actor" ? params.targetActorId || null : null,
        requested_via_profile_id: params.profileId || null,
        status: "pending",
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
  requesterWorkspaceMemberId: string;
}) {
  const existing = await db
    .selectFrom("actor_access_requests")
    .selectAll()
    .where("workspace_id", "=", params.workspaceId)
    .where("actor_id", "=", params.actorId)
    .where(
      "requester_workspace_member_id",
      "=",
      params.requesterWorkspaceMemberId,
    )
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
        requester_workspace_member_id: params.requesterWorkspaceMemberId,
        status: "pending",
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
      .where(
        "requester_workspace_member_id",
        "=",
        params.requesterWorkspaceMemberId,
      )
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
          eb("participant_one_kind", "=", "member"),
          eb("participant_one_workspace_member_id", "=", workspaceMemberId),
        ]),
        eb.and([
          eb("participant_two_kind", "=", "member"),
          eb("participant_two_workspace_member_id", "=", workspaceMemberId),
        ]),
      ]),
    )
    .execute();

  const viewerIdentity: DirectConversationIdentity = {
    kind: "member",
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
    subject: await resolveWorkspaceAccessSubject(
      params.workspaceId,
      params.userId,
    ),
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
  const viewer = await getWorkspaceMemberIdentity(params.workspaceId, params.userId);

  if (params.contactKind === "workspace-member") {
    const member = await getWorkspaceMemberSummaryById(params.contactId);
    if (!member || member.workspace.id !== params.workspaceId) {
      throw new Error("Workspace member not found");
    }
    if (viewer && member.workspaceMemberId === viewer.workspaceMemberId) {
      throw new Error("Cannot open a direct conversation with yourself");
    }
    return {
      kind: params.contactKind,
      member,
      peerIdentity: {
        kind: "member" as const,
        workspaceMemberId: member.workspaceMemberId,
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
    .where("owner_workspace_member_id", "=", viewer?.workspaceMemberId || "")
    .where("id", "=", params.contactId)
    .executeTakeFirst();
  if (!friendEntry) {
    throw new Error("Friend not found");
  }

  if (params.contactKind === "friend-member") {
    if (!friendEntry.peer_workspace_member_id) {
      throw new Error("Friend not found");
    }
    const member = await getWorkspaceMemberSummaryById(
      friendEntry.peer_workspace_member_id,
    );
    if (!member) {
      throw new Error("Friend not found");
    }
    return {
      kind: params.contactKind,
      friendEntry,
      member,
      peerIdentity: {
        kind: "member" as const,
        workspaceMemberId: member.workspaceMemberId,
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
          "a.is_public_shared",
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
        .where(
          "owner_workspace_member_id",
          "=",
          viewerWorkspaceMember?.workspaceMemberId || "",
        )
        .orderBy("created_at", "desc")
        .execute(),
      viewerWorkspaceMember
        ? db
            .selectFrom("actor_access_requests")
            .select(["actor_id"])
            .where("workspace_id", "=", params.workspaceId)
            .where(
              "requester_workspace_member_id",
              "=",
              viewerWorkspaceMember.workspaceMemberId,
            )
            .where("status", "=", "pending")
            .execute()
        : Promise.resolve([]),
    ]);

  const pendingActorAccessIds = new Set(
    pendingActorAccessRows.map((row) => row.actor_id),
  );

  const workspaceMembers = members.map((row) =>
    mapWorkspaceMemberEntry({
      member: {
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
          kind: "member",
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
      isPublicShared: Boolean(row.is_public_shared),
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
    if (entry.peer_type === "member" && entry.peer_workspace_member_id) {
      const peer = await getWorkspaceMemberSummaryById(
        entry.peer_workspace_member_id,
      );
      if (!peer) continue;
      friends.push(
        mapMemberFriendEntry({
          entryId: entry.id,
          peer,
          conversationId: directConversationMap.get(
            directConversationIdentityKey({
              kind: "member",
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
    workspaceMembers,
    workspaceActors,
    friends,
  };
}

async function createOrApproveFriendship(params: {
  requesterWorkspaceMemberId: string;
  targetType: ContactTargetType;
  targetWorkspaceMemberId?: string;
  targetActorId?: string;
  sourceRequestId?: string;
}) {
  const requester = await getWorkspaceMemberSummaryById(
    params.requesterWorkspaceMemberId,
  );
  if (!requester) {
    throw new Error("Requester workspace member not found");
  }

  await ensureFriendEntry({
    workspaceId: requester.workspace.id,
    ownerWorkspaceMemberId: requester.workspaceMemberId,
    peerType: params.targetType,
    peerWorkspaceMemberId: params.targetWorkspaceMemberId,
    peerActorId: params.targetActorId,
    sourceRequestId: params.sourceRequestId,
  });

  if (params.targetType === "member" && params.targetWorkspaceMemberId) {
    const target = await getWorkspaceMemberSummaryById(
      params.targetWorkspaceMemberId,
    );
    if (!target) {
      throw new Error("Target workspace member not found");
    }
    await ensureFriendEntry({
      workspaceId: target.workspace.id,
      ownerWorkspaceMemberId: target.workspaceMemberId,
      peerType: "member",
      peerWorkspaceMemberId: requester.workspaceMemberId,
      sourceRequestId: params.sourceRequestId,
    });
  }
}

async function resolveMemberRelationshipProfile(params: {
  workspaceId: string;
  userId: string;
  viewerWorkspaceMemberId: string;
  profile: {
    id: string;
    workspace_id: string;
    subject_type: string;
    subject_workspace_member_id: string | null;
    approval_mode: ApprovalMode;
  };
}) {
  if (
    !params.profile.subject_workspace_member_id ||
    params.profile.subject_workspace_member_id === params.viewerWorkspaceMemberId
  ) {
    return { outcome: "self_scan" as const };
  }

  const member = await getWorkspaceMemberSummaryById(
    params.profile.subject_workspace_member_id,
  );
  if (!member) {
    throw new Error("Relationship profile target not found");
  }

  if (params.profile.workspace_id === params.workspaceId) {
    return {
      outcome: "same_workspace_member" as const,
      contact: {
        kind: "workspace-member" as const,
        id: member.workspaceMemberId,
      },
    };
  }

  const existingFriend = await findExistingFriendEntry({
    workspaceId: params.workspaceId,
    ownerWorkspaceMemberId: params.viewerWorkspaceMemberId,
    peerType: "member",
    peerWorkspaceMemberId: params.profile.subject_workspace_member_id,
  });
  if (existingFriend) {
    return {
      outcome: "friend_active" as const,
      contact: {
        kind: "friend-member" as const,
        id: existingFriend.id,
      },
    };
  }

  if (params.profile.approval_mode === "auto") {
    await createOrApproveFriendship({
      requesterWorkspaceMemberId: params.viewerWorkspaceMemberId,
      targetType: "member",
      targetWorkspaceMemberId: params.profile.subject_workspace_member_id,
    });
    const entry = await findExistingFriendEntry({
      workspaceId: params.workspaceId,
      ownerWorkspaceMemberId: params.viewerWorkspaceMemberId,
      peerType: "member",
      peerWorkspaceMemberId: params.profile.subject_workspace_member_id,
    });
    return {
      outcome: "friend_active" as const,
      contact: entry
        ? {
            kind: "friend-member" as const,
            id: entry.id,
          }
        : undefined,
    };
  }

  const requestResult = await createFriendRequest({
    requesterWorkspaceMemberId: params.viewerWorkspaceMemberId,
    targetType: "member",
    targetWorkspaceMemberId: params.profile.subject_workspace_member_id,
    profileId: params.profile.id,
  });
  return {
    outcome: requestResult.created
      ? ("friend_request_created" as const)
      : ("friend_request_pending" as const),
    requestId: requestResult.request.id,
  };
}

export async function searchRelationshipsByIdentity(params: {
  workspaceId: string;
  userId: string;
  query: string;
}) {
  const normalizedQuery = normalizeIdentityId(params.query);
  if (!normalizedQuery) {
    return {
      query: normalizedQuery,
      outcome: "empty" as IdentitySearchOutcome,
      matches: [],
    };
  }
  if (!IDENTITY_ID_PATTERN.test(normalizedQuery)) {
    return {
      query: normalizedQuery,
      outcome: "invalid" as IdentitySearchOutcome,
      matches: [],
    };
  }

  const viewerWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId,
  );
  if (!viewerWorkspaceMember) {
    throw new Error("Workspace member not found");
  }

  const profile = await db
    .selectFrom("workspace_relationship_profiles")
    .selectAll()
    .where("identity_id", "=", normalizedQuery)
    .where("identity_search_enabled", "=", true)
    .executeTakeFirst();
  if (!profile) {
    return {
      query: normalizedQuery,
      outcome: "not_found" as IdentitySearchOutcome,
      matches: [],
    };
  }

  const directConversationMap = await loadViewerDirectConversationMap(
    viewerWorkspaceMember.workspaceMemberId,
  );

  if (profile.subject_type === "member") {
    if (
      profile.subject_workspace_member_id ===
      viewerWorkspaceMember.workspaceMemberId
    ) {
      return {
        query: normalizedQuery,
        outcome: "self" as IdentitySearchOutcome,
        matches: [],
      };
    }

    const member = profile.subject_workspace_member_id
      ? await getWorkspaceMemberSummaryById(profile.subject_workspace_member_id)
      : null;
    if (!member) {
      return {
        query: normalizedQuery,
        outcome: "not_found" as IdentitySearchOutcome,
        matches: [],
      };
    }

    const conversationId = directConversationMap.get(
      directConversationIdentityKey({
        kind: "member",
        workspaceMemberId: member.workspaceMemberId,
      }),
    );

    if (member.workspace.id === params.workspaceId) {
      return {
        query: normalizedQuery,
        outcome: "found" as IdentitySearchOutcome,
        matches: [
          {
            profileId: profile.id,
            targetType: "member" as const,
            title: member.name || member.email || "Unknown member",
            subtitle: `${member.workspace.name} · ${member.email}`,
            avatarUrl: member.avatarFileId
              ? getFileUrlById(member.avatarFileId)
              : undefined,
            workspace: member.workspace,
            workspaceMemberId: member.workspaceMemberId,
            userId: member.userId,
            state: "same_workspace_member" as IdentitySearchMatchState,
            contact: {
              kind: "workspace-member" as const,
              id: member.workspaceMemberId,
            },
            conversationId,
          },
        ],
      };
    }

    const existingFriend = await findExistingFriendEntry({
      workspaceId: params.workspaceId,
      ownerWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
      peerType: "member",
      peerWorkspaceMemberId: member.workspaceMemberId,
    });
    if (existingFriend) {
      return {
        query: normalizedQuery,
        outcome: "found" as IdentitySearchOutcome,
        matches: [
          {
            profileId: profile.id,
            targetType: "member" as const,
            title: member.name || member.email || "Unknown member",
            subtitle: `${member.workspace.name} · ${member.email}`,
            avatarUrl: member.avatarFileId
              ? getFileUrlById(member.avatarFileId)
              : undefined,
            workspace: member.workspace,
            workspaceMemberId: member.workspaceMemberId,
            userId: member.userId,
            state: "friend" as IdentitySearchMatchState,
            contact: {
              kind: "friend-member" as const,
              id: existingFriend.id,
            },
            conversationId,
          },
        ],
      };
    }

    const pendingRequest = await findPendingFriendRequest({
      requesterWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
      targetType: "member",
      targetWorkspaceMemberId: member.workspaceMemberId,
    });
    return {
      query: normalizedQuery,
      outcome: "found" as IdentitySearchOutcome,
      matches: [
        {
          profileId: profile.id,
          targetType: "member" as const,
          title: member.name || member.email || "Unknown member",
          subtitle: `${member.workspace.name} · ${member.email}`,
          avatarUrl: member.avatarFileId
            ? getFileUrlById(member.avatarFileId)
            : undefined,
          workspace: member.workspace,
          workspaceMemberId: member.workspaceMemberId,
          userId: member.userId,
          state: pendingRequest
            ? ("pending_request" as IdentitySearchMatchState)
            : ("requestable" as IdentitySearchMatchState),
          requestId: pendingRequest?.id,
        },
      ],
    };
  }

  const actor = profile.subject_actor_id
    ? await getActorSummary(profile.subject_actor_id)
    : null;
  if (!actor) {
    return {
      query: normalizedQuery,
      outcome: "not_found" as IdentitySearchOutcome,
      matches: [],
    };
  }

  const conversationId = directConversationMap.get(
    directConversationIdentityKey({
      kind: "actor",
      actorId: actor.actorId,
    }),
  );

  if (actor.workspace.id === params.workspaceId) {
    const pendingActorRequest = await db
      .selectFrom("actor_access_requests")
      .select(["id"])
      .where("workspace_id", "=", params.workspaceId)
      .where("actor_id", "=", actor.actorId)
      .where(
        "requester_workspace_member_id",
        "=",
        viewerWorkspaceMember.workspaceMemberId,
      )
      .where("status", "=", "pending")
      .executeTakeFirst();
    const accessState = await getActorAccessState({
      workspaceId: params.workspaceId,
      userId: params.userId,
      actor,
      conversationId,
      pendingRequestActorIds: new Set(
        pendingActorRequest ? [actor.actorId] : [],
      ),
    });
    return {
      query: normalizedQuery,
      outcome: "found" as IdentitySearchOutcome,
      matches: [
        {
          profileId: profile.id,
          targetType: "actor" as const,
          title: actor.name,
          subtitle: `${actor.workspace.name} · ${actor.title}`,
          avatarUrl: actor.avatarStoredName
            ? getFileUrl(actor.avatarStoredName)
            : undefined,
          avatarEmoji: actor.avatarEmoji || undefined,
          workspace: actor.workspace,
          actorId: actor.actorId,
          state: accessState,
          contact: {
            kind: "workspace-actor" as const,
            id: actor.actorId,
          },
          conversationId,
          requestId: pendingActorRequest?.id,
        },
      ],
    };
  }

  const existingFriend = await findExistingFriendEntry({
    workspaceId: params.workspaceId,
    ownerWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
    peerType: "actor",
    peerActorId: actor.actorId,
  });
  if (existingFriend) {
    return {
      query: normalizedQuery,
      outcome: "found" as IdentitySearchOutcome,
      matches: [
        {
          profileId: profile.id,
          targetType: "actor" as const,
          title: actor.name,
          subtitle: `${actor.workspace.name} · ${actor.title}`,
          avatarUrl: actor.avatarStoredName
            ? getFileUrl(actor.avatarStoredName)
            : undefined,
          avatarEmoji: actor.avatarEmoji || undefined,
          workspace: actor.workspace,
          actorId: actor.actorId,
          state: "friend" as const,
          contact: {
            kind: "friend-actor" as const,
            id: existingFriend.id,
          },
          conversationId,
        },
      ],
    };
  }

  const pendingRequest = await findPendingFriendRequest({
    requesterWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
    targetType: "actor",
    targetActorId: actor.actorId,
  });
  return {
    query: normalizedQuery,
    outcome: "found" as IdentitySearchOutcome,
    matches: [
      {
        profileId: profile.id,
        targetType: "actor" as const,
        title: actor.name,
        subtitle: `${actor.workspace.name} · ${actor.title}`,
        avatarUrl: actor.avatarStoredName
          ? getFileUrl(actor.avatarStoredName)
          : undefined,
        avatarEmoji: actor.avatarEmoji || undefined,
        workspace: actor.workspace,
        actorId: actor.actorId,
        state: pendingRequest ? ("pending_request" as const) : ("requestable" as const),
        requestId: pendingRequest?.id,
      },
    ],
  };
}

export async function requestRelationshipByIdentityProfile(params: {
  workspaceId: string;
  userId: string;
  profileId: string;
  requireSearchable?: boolean;
}) {
  const viewerWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId,
  );
  if (!viewerWorkspaceMember) {
    throw new Error("Workspace member not found");
  }

  const profile = await db
    .selectFrom("workspace_relationship_profiles")
    .selectAll()
    .where("id", "=", params.profileId)
    .executeTakeFirst();
  if (!profile) {
    throw new Error("Search target not found");
  }
  if (params.requireSearchable !== false && !profile.identity_search_enabled) {
    throw new Error("Search target not found");
  }

  if (profile.subject_type === "member") {
    return resolveMemberRelationshipProfile({
      workspaceId: params.workspaceId,
      userId: params.userId,
      viewerWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
      profile: {
        id: profile.id,
        workspace_id: profile.workspace_id,
        subject_type: profile.subject_type,
        subject_workspace_member_id: profile.subject_workspace_member_id,
        approval_mode: profile.approval_mode as ApprovalMode,
      },
    });
  }

  const actor = profile.subject_actor_id
    ? await getActorSummary(profile.subject_actor_id)
    : null;
  if (!actor) {
    throw new Error("Relationship profile target not found");
  }

  if (profile.workspace_id === params.workspaceId) {
    const canInvoke = await authorizeAction({
      subject: await resolveWorkspaceAccessSubject(
        params.workspaceId,
        params.userId,
      ),
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
        requesterWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
        grantedByWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
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
      requesterWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
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
    ownerWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
    peerType: "actor",
    peerActorId: actor.actorId,
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
      requesterWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
      targetType: "actor",
      targetActorId: actor.actorId,
    });
    const entry = await findExistingFriendEntry({
      workspaceId: params.workspaceId,
      ownerWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
      peerType: "actor",
      peerActorId: actor.actorId,
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
    requesterWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
    targetType: "actor",
    targetActorId: actor.actorId,
    profileId: profile.id,
  });
  return {
    outcome: requestResult.created
      ? ("friend_request_created" as const)
      : ("friend_request_pending" as const),
    requestId: requestResult.request.id,
  };
}

export async function getMemberRelationshipProfile(params: {
  workspaceId: string;
  userId: string;
}) {
  const viewerWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId,
  );
  if (!viewerWorkspaceMember) {
    throw new Error("Workspace member not found");
  }
  const profile = await ensureRelationshipProfile({
    workspaceId: params.workspaceId,
    createdByWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
    subjectType: "member",
    subjectWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
  });
  return {
    subjectType: "member" as const,
    approvalMode: profile.approval_mode,
    qrToken: profile.qr_token,
    qrUrl: buildRelationshipQrUrl(profile.qr_token),
    identityId: profile.identity_id,
    identitySearchEnabled: profile.identity_search_enabled,
  };
}

export async function updateMemberRelationshipProfile(params: {
  workspaceId: string;
  userId: string;
  approvalMode: ApprovalMode;
  identityId?: string;
  identitySearchEnabled?: boolean;
}) {
  const viewerWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId,
  );
  if (!viewerWorkspaceMember) {
    throw new Error("Workspace member not found");
  }
  const profile = await ensureRelationshipProfile({
    workspaceId: params.workspaceId,
    createdByWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
    subjectType: "member",
    subjectWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
  });
  try {
    const updated = await db
      .updateTable("workspace_relationship_profiles")
      .set({
        approval_mode: params.approvalMode,
        identity_id:
          typeof params.identityId === "string"
            ? validateIdentityId(params.identityId)
            : profile.identity_id,
        identity_search_enabled:
          typeof params.identitySearchEnabled === "boolean"
            ? params.identitySearchEnabled
            : profile.identity_search_enabled,
        updated_at: sql`NOW()`,
      })
      .where("id", "=", profile.id)
      .returningAll()
      .executeTakeFirst();
    if (!updated) {
      throw new Error("Failed to update relationship profile");
    }
    return {
      subjectType: "member" as const,
      approvalMode: updated.approval_mode,
      qrToken: updated.qr_token,
      qrUrl: buildRelationshipQrUrl(updated.qr_token),
      identityId: updated.identity_id,
      identitySearchEnabled: updated.identity_search_enabled,
    };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new Error("This identity ID is already taken.");
    }
    throw error;
  }
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
  const viewerWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId,
  );
  if (!viewerWorkspaceMember) {
    throw new Error("Workspace member not found");
  }
  const profile = await ensureRelationshipProfile({
    workspaceId: params.workspaceId,
    createdByWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
    subjectType: "actor",
    subjectActorId: params.actorId,
  });
  return {
    subjectType: "actor" as const,
    approvalMode: profile.approval_mode,
    qrToken: profile.qr_token,
    qrUrl: buildRelationshipQrUrl(profile.qr_token),
    identityId: profile.identity_id,
    identitySearchEnabled: profile.identity_search_enabled,
    accessPolicy: actor.accessPolicy,
    isPublicShared: actor.isPublicShared,
  };
}

export async function updateActorRelationshipProfile(params: {
  workspaceId: string;
  actorId: string;
  userId: string;
  approvalMode: ApprovalMode;
  identityId?: string;
  identitySearchEnabled?: boolean;
  accessPolicy?: AccessPolicy;
  isPublicShared?: boolean;
}) {
  const viewerWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId,
  );
  if (!viewerWorkspaceMember) {
    throw new Error("Workspace member not found");
  }
  const profile = await ensureRelationshipProfile({
    workspaceId: params.workspaceId,
    createdByWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
    subjectType: "actor",
    subjectActorId: params.actorId,
  });

  let updatedProfile;
  try {
    updatedProfile = await db
      .updateTable("workspace_relationship_profiles")
      .set({
        approval_mode: params.approvalMode,
        identity_id:
          typeof params.identityId === "string"
            ? validateIdentityId(params.identityId)
            : profile.identity_id,
        identity_search_enabled:
          typeof params.identitySearchEnabled === "boolean"
            ? params.identitySearchEnabled
            : profile.identity_search_enabled,
        updated_at: sql`NOW()`,
      })
      .where("id", "=", profile.id)
      .returningAll()
      .executeTakeFirst();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new Error("This identity ID is already taken.");
    }
    throw error;
  }
  if (!updatedProfile) {
    throw new Error("Failed to update relationship profile");
  }

  const actorSummary = await getActorSummary(params.actorId);
  let accessPolicy = actorSummary?.accessPolicy;
  let isPublicShared = actorSummary?.isPublicShared ?? false;
  if (params.accessPolicy) {
    const actorResult = await updateActorAccessPolicy({
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      updatedByWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
      accessPolicy: params.accessPolicy,
    });
    accessPolicy = actorResult.access_policy as AccessPolicy;
  }
  if (typeof params.isPublicShared === "boolean") {
    const actorResult = await db
      .updateTable("actors")
      .set({
        is_public_shared: params.isPublicShared,
        updated_at: sql`NOW()`,
      })
      .where("id", "=", params.actorId)
      .where("workspace_id", "=", params.workspaceId)
      .returning(["is_public_shared"])
      .executeTakeFirst();
    if (!actorResult) {
      throw new Error("Actor not found");
    }
    isPublicShared = Boolean(actorResult.is_public_shared);
  }

  return {
    subjectType: "actor" as const,
    approvalMode: updatedProfile.approval_mode,
    qrToken: updatedProfile.qr_token,
    qrUrl: buildRelationshipQrUrl(updatedProfile.qr_token),
    identityId: updatedProfile.identity_id,
    identitySearchEnabled: updatedProfile.identity_search_enabled,
    accessPolicy: accessPolicy || "workspace_open",
    isPublicShared,
  };
}

export async function scanRelationshipQr(params: {
  workspaceId: string;
  userId: string;
  token: string;
}) {
  const viewerWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId,
  );
  if (!viewerWorkspaceMember) {
    throw new Error("Workspace member not found");
  }

  const profile = await db
    .selectFrom("workspace_relationship_profiles")
    .selectAll()
    .where("qr_token", "=", params.token)
    .executeTakeFirst();
  if (!profile) {
    throw new Error("Relationship QR code not found");
  }

  if (profile.subject_type === "member") {
    return resolveMemberRelationshipProfile({
      workspaceId: params.workspaceId,
      userId: params.userId,
      viewerWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
      profile: {
        id: profile.id,
        workspace_id: profile.workspace_id,
        subject_type: profile.subject_type,
        subject_workspace_member_id: profile.subject_workspace_member_id,
        approval_mode: profile.approval_mode as ApprovalMode,
      },
    });
  }

  return requestRelationshipByIdentityProfile({
    workspaceId: params.workspaceId,
    userId: params.userId,
    profileId: profile.id,
    requireSearchable: false,
  });
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
  const viewerWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId,
  );
  if (!viewerWorkspaceMember) {
    throw new Error("Workspace member not found");
  }

  const pendingRows = await db
    .selectFrom("workspace_friend_requests")
    .selectAll()
    .where("status", "=", "pending")
    .orderBy("created_at", "desc")
    .execute();
  const outgoingRows = pendingRows.filter(
    (row) =>
      row.requester_workspace_member_id ===
      viewerWorkspaceMember.workspaceMemberId,
  );

  const incoming = [];
  for (const row of pendingRows) {
    if (row.target_subject_type === "member") {
      if (
        row.target_workspace_member_id !==
        viewerWorkspaceMember.workspaceMemberId
      ) {
        continue;
      }
    } else if (row.target_actor_id) {
      const targetActor = await getActorSummary(row.target_actor_id);
      if (!targetActor || targetActor.workspace.id !== params.workspaceId) {
        continue;
      }
      const canApprove = await authorizeAction({
        subject: await resolveWorkspaceAccessSubject(
          params.workspaceId,
          params.userId,
        ),
        action: "actor.grant",
        resourceId: row.target_actor_id,
      });
      if (!canApprove) continue;
    }

    const requester = await getWorkspaceMemberSummaryById(
      row.requester_workspace_member_id,
    );
    const targetMember =
      row.target_subject_type === "member" && row.target_workspace_member_id
        ? await getWorkspaceMemberSummaryById(row.target_workspace_member_id)
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
      targetMember,
      targetActor,
    });
  }

  const outgoing = [];
  for (const row of outgoingRows) {
    const targetMember =
      row.target_subject_type === "member" && row.target_workspace_member_id
        ? await getWorkspaceMemberSummaryById(row.target_workspace_member_id)
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
      targetMember,
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
  const viewerWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId,
  );
  if (!viewerWorkspaceMember) {
    throw new Error("Workspace member not found");
  }
  const request = await db
    .selectFrom("workspace_friend_requests")
    .selectAll()
    .where("id", "=", params.requestId)
    .executeTakeFirst();
  if (!request) {
    throw new Error("Friend request not found");
  }
  if (request.status !== "pending") {
    throw new Error("Friend request has already been resolved");
  }

  if (request.target_subject_type === "member") {
    if (
      request.target_workspace_member_id !==
      viewerWorkspaceMember.workspaceMemberId
    ) {
      throw new Error("Not allowed to resolve this friend request");
    }
  } else if (request.target_actor_id) {
    const targetActor = await getActorSummary(request.target_actor_id);
    if (!targetActor || targetActor.workspace.id !== params.workspaceId) {
      throw new Error("Friend request not found");
    }
    const canApprove = await authorizeAction({
      subject: await resolveWorkspaceAccessSubject(
        params.workspaceId,
        params.userId,
      ),
      action: "actor.grant",
      resourceId: request.target_actor_id,
    });
    if (!canApprove) {
      throw new Error("Not allowed to resolve this friend request");
    }
  }

  if (params.decision === "approve") {
    await createOrApproveFriendship({
      requesterWorkspaceMemberId: request.requester_workspace_member_id,
      targetType: request.target_subject_type as ContactTargetType,
      targetWorkspaceMemberId: request.target_workspace_member_id || undefined,
      targetActorId: request.target_actor_id || undefined,
      sourceRequestId: request.id,
    });
  }

  const updated = await db
    .updateTable("workspace_friend_requests")
    .set({
      status: params.decision === "approve" ? "approved" : "rejected",
      resolved_by_workspace_member_id:
        viewerWorkspaceMember.workspaceMemberId,
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
  const viewerWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId,
  );
  if (!viewerWorkspaceMember) {
    throw new Error("Workspace member not found");
  }
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
      .where(
        "requester_workspace_member_id",
        "=",
        viewerWorkspaceMember.workspaceMemberId,
      )
      .where("status", "=", "pending")
      .execute(),
  ]);

  const incoming = [];
  for (const row of incomingRows) {
    const canApprove = await authorizeAction({
      subject: await resolveWorkspaceAccessSubject(
        params.workspaceId,
        params.userId,
      ),
      action: "actor.grant",
      resourceId: row.actor_id,
    });
    if (!canApprove) continue;
    incoming.push({
      id: row.id,
      status: row.status,
      createdAt: toIsoString(row.created_at),
      requester: await getWorkspaceMemberSummaryById(
        row.requester_workspace_member_id,
      ),
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
  const approverWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId,
  );
  if (!approverWorkspaceMember) {
    throw new Error("Workspace member not found");
  }
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
    subject: await resolveWorkspaceAccessSubject(
      params.workspaceId,
      params.userId,
    ),
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
      requesterWorkspaceMemberId: request.requester_workspace_member_id,
      grantedByWorkspaceMemberId: approverWorkspaceMember.workspaceMemberId,
    });
  }

  const updated = await db
    .updateTable("actor_access_requests")
    .set({
      status: params.decision === "approve" ? "approved" : "rejected",
      resolved_by_workspace_member_id:
        approverWorkspaceMember.workspaceMemberId,
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
  if (!viewerWorkspaceMember) {
    throw new Error("Workspace member not found");
  }
  const [{ incoming: friendIncoming }, { incoming: actorIncoming }, entries] =
    await Promise.all([
      listFriendRequests(params),
      listActorAccessRequests(params),
      buildContactHubEntryMap(params),
    ]);
  const threads = await getThreadsForWorkspaceMember({
    workspaceId: params.workspaceId,
    workspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
  });
  const groups = await Promise.all(
    threads
      .filter((thread) => thread.kind === "group")
      .map((thread) =>
        mapConversationSummaryView(thread, {
          workspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
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
    workspaceMembers: entries.workspaceMembers,
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
    ...hub.workspaceMembers,
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
    if (entry.workspaceMemberId) {
      return conversation.members.some(
        (member) =>
          member.type === "workspace_member" &&
          member.workspaceMemberId === entry.workspaceMemberId,
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
    kind: "member",
    workspaceMemberId: requesterWorkspaceMember.workspaceMemberId,
  };

  if (resolved.kind === "workspace-actor" && resolved.actor) {
    const canInvoke = await authorizeAction({
      subject: await resolveWorkspaceAccessSubject(
        params.workspaceId,
        params.userId,
      ),
      action: "actor.invoke",
      resourceId: resolved.actor.actorId,
    });

    if (!canInvoke && resolved.actor.accessPolicy === "approval_required") {
      const profile = await ensureRelationshipProfile({
        workspaceId: params.workspaceId,
        createdByWorkspaceMemberId: requesterWorkspaceMember.workspaceMemberId,
        subjectType: "actor",
        subjectActorId: resolved.actor.actorId,
      });
      if (profile.approval_mode === "auto") {
        await grantActorAccess({
          workspaceId: params.workspaceId,
          actorId: resolved.actor.actorId,
          requesterWorkspaceMemberId: requesterWorkspaceMember.workspaceMemberId,
          grantedByWorkspaceMemberId: requesterWorkspaceMember.workspaceMemberId,
        });
      } else {
        const accessRequest = await createActorAccessRequest({
          workspaceId: params.workspaceId,
          actorId: resolved.actor.actorId,
          requesterWorkspaceMemberId:
            requesterWorkspaceMember.workspaceMemberId,
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
      resolved.peerIdentity.kind === "member"
        ? resolved.member?.workspaceMemberId
        : undefined;
    if (resolved.peerIdentity.kind === "member" && !targetWorkspaceMemberId) {
      throw new Error("Peer workspace membership not found");
    }
    const created = await createThread({
      workspaceId: params.workspaceId,
      kind: "private",
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
