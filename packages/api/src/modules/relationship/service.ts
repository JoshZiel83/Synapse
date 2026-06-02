import { sql } from "kysely"
import { v4 as uuidv4 } from "uuid"
import {
  CONTACT_DIRECT_STATE,
  CONTACT_HUB_KIND,
  CONVERSATION_KIND,
  CONVERSATION_PARTICIPANT_TYPE,
  CONTACT_TARGET_TYPE,
  DIRECT_CONVERSATION_OPEN_STATUS,
  IDENTITY_SEARCH_MATCH_STATE,
  IDENTITY_SEARCH_OUTCOME,
  RELATIONSHIP_ACCESS_POLICY,
  RELATIONSHIP_APPROVAL_MODE,
  RELATIONSHIP_PROFILE_SUBJECT_TYPE,
  RELATIONSHIP_SCAN_OUTCOME,
  type ActorAccessRequestListResponse,
  type ContactHubDetailResponse,
  type ContactHubEntryView,
  type ContactHubKind,
  type ContactHubResponse,
  type ContactTargetType,
  type DirectConversationOpenResponse,
  type FriendRequestListResponse,
  type IdentitySearchMatchState,
  type IdentitySearchOutcome,
  type IdentitySearchResponse,
  type RelationshipAccessPolicy,
  type RelationshipActorSummaryView,
  type RelationshipApprovalMode,
  type RelationshipMemberSummaryView,
  type RelationshipProfileView,
  type RelationshipRemoteAgentSummaryView,
  type RelationshipScanResponse,
  type RemoteAgentAccessRequestListResponse,
} from "@synapse/shared"
import { transaction } from "../../infrastructure/database/index.js"
import { executeSqlOn } from "../../infrastructure/database/kysely.js"
import {
  db,
  executeSql,
  executeCompiledQuery,
  executeTakeFirst,
} from "../../infrastructure/database/kysely.js"
import { getFileUrlById } from "../files/service.js"
import {
  authorizeAction,
  resolveWorkspaceAccessSubject,
  userSubject,
  workspaceMemberSubject,
} from "../access/service.js"
import {
  deriveAccessPolicy,
  deriveAccessPolicyMany,
  grantApprovedAccess,
  setAccessPolicy,
  setAccessPolicyOn,
} from "../access/default-access-policy.js"
import {
  createChatConversation,
  listWorkspaceConversationViews,
} from "../chat/service.js"
import { getWorkspaceMemberIdentity } from "../chat/workspace-identity.js"
import {
  canonicalizeDirectConversationPair,
  directConversationBindingPeer,
  directConversationBindingValues,
  directConversationIdentityKey,
  type DirectConversationIdentity,
} from "../chat/direct-binding.js"
import { mapConversationSummaryView } from "../chat/summary-view.js"
import { SUBJECT_KIND, type SubjectRef } from "@synapse/shared"
import {
  upsertAccessSubject,
  loadAccessSubject,
} from "../access/subject-registry.js"

/**
 * P1b: translate a relationship target type (`member` | `actor` | `remote_agent`)
 * into a SubjectRef. Used by friend_entries / friend_requests / relationship_profiles
 * to populate their `*_subject_id` columns.
 */
function buildRelationshipPeerSubjectRef(input: {
  peerType: ContactTargetType
  peerWorkspaceMemberId?: string | null
  peerActorId?: string | null
  peerRemoteAgentId?: string | null
}): SubjectRef {
  switch (input.peerType) {
    case "workspace_member":
      if (!input.peerWorkspaceMemberId) {
        throw new Error("peerWorkspaceMemberId required for member peer type")
      }
      return {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId: input.peerWorkspaceMemberId,
      }
    case "actor":
      if (!input.peerActorId) {
        throw new Error("peerActorId required for actor peer type")
      }
      return { kind: SUBJECT_KIND.ACTOR, actorId: input.peerActorId }
    case "remote_agent":
      if (!input.peerRemoteAgentId) {
        throw new Error("peerRemoteAgentId required for remote_agent peer type")
      }
      return {
        kind: SUBJECT_KIND.REMOTE_AGENT,
        remoteAgentId: input.peerRemoteAgentId,
      }
  }
}

function subjectKindToRelationshipPeerType(
  kind: SubjectRef["kind"]
): ContactTargetType {
  switch (kind) {
    case SUBJECT_KIND.WORKSPACE_MEMBER:
      return "workspace_member"
    case SUBJECT_KIND.ACTOR:
      return "actor"
    case SUBJECT_KIND.REMOTE_AGENT:
      return "remote_agent"
    default:
      throw new Error(`Unsupported subject kind for relationship peer: ${kind}`)
  }
}

type ApprovalMode = RelationshipApprovalMode
type AccessPolicy = RelationshipAccessPolicy

type WorkspaceSummary = {
  id: string
  name: string
  slug: string
}

type WorkspaceMemberSummary = RelationshipMemberSummaryView
type ActorSummary = RelationshipActorSummaryView
type RemoteAgentSummary = RelationshipRemoteAgentSummaryView
type ContactHubEntry = ContactHubEntryView

const IDENTITY_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{3,31})$/

function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  )
}

function toIsoString(value: string | Date | null | undefined) {
  if (typeof value === "string") return value
  if (value instanceof Date) return value.toISOString()
  return new Date(0).toISOString()
}

function normalizeIdentityId(value: string) {
  return value.trim().toLowerCase()
}

function validateIdentityId(value: string) {
  const normalized = normalizeIdentityId(value)
  if (!IDENTITY_ID_PATTERN.test(normalized)) {
    throw new Error(
      "Identity ID must be 4-32 characters using letters, numbers, dot, underscore, or hyphen."
    )
  }
  return normalized
}

function buildRelationshipQrUrl(token: string) {
  return `synapse://relationship-qr?token=${encodeURIComponent(token)}`
}

function workspaceSummary(row: {
  workspace_id?: string
  workspace_name?: string
  workspace_slug?: string
  id?: string
  name?: string
  slug?: string
}) {
  return {
    id: row.workspace_id || row.id || "",
    name: row.workspace_name || row.name || "Unknown workspace",
    slug: row.workspace_slug || row.slug || "",
  }
}

async function getWorkspaceById(
  workspaceId: string
): Promise<WorkspaceSummary | null> {
  const row = await db
    .selectFrom("workspaces")
    .select(["id", "name", "slug"])
    .where("id", "=", workspaceId)
    .executeTakeFirst()
  return row ? workspaceSummary(row) : null
}

async function getWorkspaceMemberSummaryByUser(
  workspaceId: string,
  userId: string
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
    .executeTakeFirst()
  if (!row) return null
  return {
    workspace: workspaceSummary(row),
    workspaceMemberId: row.workspace_member_id,
    userId: row.user_id,
    trustLevel: row.trust_level,
    name: row.name,
    email: row.email,
    avatarFileId: row.avatar_file_id,
  }
}

async function getWorkspaceMemberSummaryById(
  workspaceMemberId: string
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
    .executeTakeFirst()
  if (!row) return null
  return {
    workspace: workspaceSummary(row),
    workspaceMemberId: row.workspace_member_id,
    userId: row.user_id,
    trustLevel: row.trust_level,
    name: row.name,
    email: row.email,
    avatarFileId: row.avatar_file_id,
  }
}

async function getMemberRelationshipProfileRow(workspaceMemberId: string) {
  const subjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    memberId: workspaceMemberId,
  })
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
    .where("subject_id", "=", subjectId)
    .executeTakeFirst()
  if (!row) {
    throw new Error("Relationship profile not found")
  }
  return row
}

async function getActorSummary(actorId: string): Promise<ActorSummary | null> {
  const row = await db
    .selectFrom("actors as a")
    .innerJoin("workspaces as w", "w.id", "a.workspace_id")
    .leftJoin(
      "file_assets as avatar_file",
      "avatar_file.id",
      "a.avatar_file_id"
    )
    .select([
      "a.id as actor_id",
      "a.workspace_id",
      "w.name as workspace_name",
      "w.slug as workspace_slug",
      "a.name",
      "a.title",
      "a.role",
      "a.is_public_shared",
      "a.avatar_emoji",
      "avatar_file.id as avatar_file_id",
    ])
    .where("a.id", "=", actorId)
    .where("a.is_active", "=", true)
    .executeTakeFirst()
  if (!row) return null
  const accessPolicy = await deriveAccessPolicy(
    db,
    "actor",
    row.actor_id,
    row.workspace_id
  )
  return {
    workspace: workspaceSummary(row),
    actorId: row.actor_id,
    name: row.name,
    title: row.title,
    role: row.role,
    avatarFileId: row.avatar_file_id,
    avatarEmoji: row.avatar_emoji,
    accessPolicy,
    isPublicShared: Boolean(row.is_public_shared),
  }
}

async function getRemoteAgentSummary(
  remoteAgentId: string
): Promise<RemoteAgentSummary | null> {
  const result = await executeSql<{
    remote_agent_id: string
    workspace_id: string
    workspace_name: string
    workspace_slug: string
    name: string
    title: string
    runtime_kind: "claude_code" | "codex"
    avatar_file_id: string | null
    avatar_emoji: string | null
    is_public_shared: boolean
  }>(
    `
      SELECT
        ra.id AS remote_agent_id,
        ra.workspace_id,
        w.name AS workspace_name,
        w.slug AS workspace_slug,
        ra.name,
        ra.title,
        ra.runtime_kind,
        ra.avatar_file_id,
        ra.avatar_emoji,
        ra.is_public_shared
      FROM remote_agents ra
      INNER JOIN workspaces w ON w.id = ra.workspace_id
      WHERE ra.id = $1
        AND ra.is_active = TRUE
      LIMIT 1
    `,
    [remoteAgentId]
  )

  const row = result.rows[0]
  if (!row) return null
  const accessPolicy = await deriveAccessPolicy(
    db,
    "remote_agent",
    row.remote_agent_id,
    row.workspace_id
  )
  return {
    workspace: workspaceSummary(row),
    remoteAgentId: row.remote_agent_id,
    name: row.name,
    title: row.title,
    runtimeKind: row.runtime_kind,
    avatarFileId: row.avatar_file_id,
    avatarEmoji: row.avatar_emoji,
    accessPolicy,
    isPublicShared: Boolean(row.is_public_shared),
  }
}

function mapMemberFriendEntry(params: {
  entryId: string
  peer: WorkspaceMemberSummary
  conversationId?: string
}): ContactHubEntry {
  return {
    kind: CONTACT_HUB_KIND.FRIEND_MEMBER,
    id: params.entryId,
    targetType: RELATIONSHIP_PROFILE_SUBJECT_TYPE.MEMBER,
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
      ? {
          status: CONTACT_DIRECT_STATE.EXISTING,
          conversationId: params.conversationId,
        }
      : { status: CONTACT_DIRECT_STATE.AVAILABLE },
  }
}

function mapActorFriendEntry(params: {
  entryId: string
  actor: ActorSummary
  conversationId?: string
}): ContactHubEntry {
  return {
    kind: CONTACT_HUB_KIND.FRIEND_ACTOR,
    id: params.entryId,
    targetType: RELATIONSHIP_PROFILE_SUBJECT_TYPE.ACTOR,
    title: params.actor.name,
    subtitle: `${params.actor.workspace.name} · ${params.actor.title}`,
    avatarUrl: params.actor.avatarFileId
      ? getFileUrlById(params.actor.avatarFileId)
      : undefined,
    avatarEmoji: params.actor.avatarEmoji || undefined,
    workspace: params.actor.workspace,
    actorId: params.actor.actorId,
    relationLabel: "Friend",
    directState: params.conversationId
      ? {
          status: CONTACT_DIRECT_STATE.EXISTING,
          conversationId: params.conversationId,
        }
      : { status: CONTACT_DIRECT_STATE.AVAILABLE },
  }
}

function mapRemoteAgentFriendEntry(params: {
  entryId: string
  remoteAgent: RemoteAgentSummary
  conversationId?: string
}): ContactHubEntry {
  return {
    kind: CONTACT_HUB_KIND.FRIEND_REMOTE_AGENT,
    id: params.entryId,
    targetType: RELATIONSHIP_PROFILE_SUBJECT_TYPE.REMOTE_AGENT,
    title: params.remoteAgent.name,
    subtitle: `${params.remoteAgent.workspace.name} · ${params.remoteAgent.title}`,
    avatarUrl: params.remoteAgent.avatarFileId
      ? getFileUrlById(params.remoteAgent.avatarFileId)
      : undefined,
    avatarEmoji: params.remoteAgent.avatarEmoji || undefined,
    workspace: params.remoteAgent.workspace,
    remoteAgentId: params.remoteAgent.remoteAgentId,
    relationLabel: "Friend",
    directState: params.conversationId
      ? {
          status: CONTACT_DIRECT_STATE.EXISTING,
          conversationId: params.conversationId,
        }
      : { status: CONTACT_DIRECT_STATE.AVAILABLE },
  }
}

function mapWorkspaceMemberEntry(params: {
  member: WorkspaceMemberSummary
  conversationId?: string
}): ContactHubEntry {
  return {
    kind: CONTACT_HUB_KIND.WORKSPACE_MEMBER,
    id: params.member.workspaceMemberId,
    targetType: RELATIONSHIP_PROFILE_SUBJECT_TYPE.MEMBER,
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
      ? {
          status: CONTACT_DIRECT_STATE.EXISTING,
          conversationId: params.conversationId,
        }
      : { status: CONTACT_DIRECT_STATE.AVAILABLE },
  }
}

function mapWorkspaceActorEntry(params: {
  actor: ActorSummary
  conversationId?: string
  accessState: ContactHubEntry["directState"]["status"]
}): ContactHubEntry {
  return {
    kind: CONTACT_HUB_KIND.WORKSPACE_ACTOR,
    id: params.actor.actorId,
    targetType: RELATIONSHIP_PROFILE_SUBJECT_TYPE.ACTOR,
    title: params.actor.name,
    subtitle: params.actor.title,
    avatarUrl: params.actor.avatarFileId
      ? getFileUrlById(params.actor.avatarFileId)
      : undefined,
    avatarEmoji: params.actor.avatarEmoji || undefined,
    workspace: params.actor.workspace,
    actorId: params.actor.actorId,
    relationLabel: "Workspace actor",
    directState:
      params.accessState === CONTACT_DIRECT_STATE.EXISTING
        ? {
            status: CONTACT_DIRECT_STATE.EXISTING,
            conversationId: params.conversationId,
          }
        : { status: params.accessState },
  }
}

function mapWorkspaceRemoteAgentEntry(params: {
  remoteAgent: RemoteAgentSummary
  conversationId?: string
  accessState: ContactHubEntry["directState"]["status"]
}): ContactHubEntry {
  return {
    kind: CONTACT_HUB_KIND.WORKSPACE_REMOTE_AGENT,
    id: params.remoteAgent.remoteAgentId,
    targetType: RELATIONSHIP_PROFILE_SUBJECT_TYPE.REMOTE_AGENT,
    title: params.remoteAgent.name,
    subtitle: params.remoteAgent.title,
    avatarUrl: params.remoteAgent.avatarFileId
      ? getFileUrlById(params.remoteAgent.avatarFileId)
      : undefined,
    avatarEmoji: params.remoteAgent.avatarEmoji || undefined,
    workspace: params.remoteAgent.workspace,
    remoteAgentId: params.remoteAgent.remoteAgentId,
    relationLabel: "Workspace agent",
    directState:
      params.accessState === CONTACT_DIRECT_STATE.EXISTING
        ? {
            status: CONTACT_DIRECT_STATE.EXISTING,
            conversationId: params.conversationId,
          }
        : { status: params.accessState },
  }
}

async function ensureRelationshipProfile(params: {
  workspaceId: string
  createdByWorkspaceMemberId: string
  subjectType: ContactTargetType
  subjectWorkspaceMemberId?: string
  subjectActorId?: string
  subjectRemoteAgentId?: string
}) {
  const subjectRef = buildRelationshipPeerSubjectRef({
    peerType: params.subjectType,
    peerWorkspaceMemberId: params.subjectWorkspaceMemberId,
    peerActorId: params.subjectActorId,
    peerRemoteAgentId: params.subjectRemoteAgentId,
  })
  const subjectId = await upsertAccessSubject(db, subjectRef)
  const existing = await db
    .selectFrom("workspace_relationship_profiles")
    .selectAll()
    .where("workspace_id", "=", params.workspaceId)
    .where("subject_id", "=", subjectId)
    .executeTakeFirst()
  if (existing) return existing

  const inserted = await db
    .insertInto("workspace_relationship_profiles")
    .values({
      workspace_id: params.workspaceId,
      subject_id: subjectId,
      qr_token: uuidv4(),
      created_by_workspace_member_id: params.createdByWorkspaceMemberId,
      approval_mode: "manual",
    })
    .returningAll()
    .executeTakeFirst()
  if (!inserted) {
    throw new Error("Failed to create relationship profile")
  }
  return inserted
}

async function updateActorAccessPolicy(params: {
  workspaceId: string
  actorId: string
  updatedByWorkspaceMemberId: string
  accessPolicy: AccessPolicy
}) {
  const actor = await db
    .selectFrom("actors")
    .select(["id", "workspace_id"])
    .where("id", "=", params.actorId)
    .executeTakeFirst()
  if (!actor || actor.workspace_id !== params.workspaceId) {
    throw new Error("Actor not found")
  }
  await transaction(async (client) => {
    await setAccessPolicyOn(client, {
      resourceType: "actor",
      resourceId: actor.id,
      workspaceId: actor.workspace_id,
      policy: params.accessPolicy,
      createdByWorkspaceMemberId: params.updatedByWorkspaceMemberId,
    })
    await executeSqlOn(
      client,
      `UPDATE actors SET updated_at = NOW() WHERE id = $1`,
      [actor.id]
    )
  })
  return {
    id: actor.id,
    workspace_id: actor.workspace_id,
    access_policy: params.accessPolicy,
  }
}

async function updateRemoteAgentAccessPolicy(params: {
  workspaceId: string
  remoteAgentId: string
  accessPolicy: AccessPolicy
}) {
  const remoteAgent = await db
    .selectFrom("remote_agents")
    .select(["id", "workspace_id"])
    .where("id", "=", params.remoteAgentId)
    .where("workspace_id", "=", params.workspaceId)
    .where("is_active", "=", true)
    .executeTakeFirst()
  if (!remoteAgent) {
    throw new Error("Remote agent not found")
  }
  await setAccessPolicy(db, {
    resourceType: "remote_agent",
    resourceId: remoteAgent.id,
    workspaceId: remoteAgent.workspace_id,
    policy: params.accessPolicy,
  })
  await db
    .updateTable("remote_agents")
    .set({ updated_at: sql`NOW()` })
    .where("id", "=", remoteAgent.id)
    .execute()
  return {
    id: remoteAgent.id,
    workspace_id: remoteAgent.workspace_id,
    access_policy: params.accessPolicy,
  }
}

async function grantActorAccess(params: {
  workspaceId: string
  actorId: string
  requesterWorkspaceMemberId: string
  grantedByWorkspaceMemberId: string
}) {
  const requester = await getWorkspaceMemberSummaryById(
    params.requesterWorkspaceMemberId
  )
  if (!requester || requester.workspace.id !== params.workspaceId) {
    throw new Error("Workspace member not found")
  }

  // P2 contract: approval grants the requester a workspace_member-scoped
  // binding (source=approval) — the canonical authorization mechanism. The
  // friend_entries row, if any, only serves the social/contact graph.
  await grantApprovedAccess(db, {
    resourceType: "actor",
    resourceId: params.actorId,
    workspaceId: params.workspaceId,
    grantedToMemberId: requester.workspaceMemberId,
    grantedByWorkspaceMemberId: params.grantedByWorkspaceMemberId,
  })
  await ensureFriendEntry({
    workspaceId: params.workspaceId,
    ownerWorkspaceMemberId: requester.workspaceMemberId,
    peerType: "actor",
    peerActorId: params.actorId,
  })
}

async function grantRemoteAgentAccess(params: {
  workspaceId: string
  remoteAgentId: string
  requesterWorkspaceMemberId: string
  grantedByWorkspaceMemberId?: string
}) {
  const requester = await getWorkspaceMemberSummaryById(
    params.requesterWorkspaceMemberId
  )
  if (!requester || requester.workspace.id !== params.workspaceId) {
    throw new Error("Workspace member not found")
  }

  // P2 contract: same as grantActorAccess — write a member-scoped binding.
  await grantApprovedAccess(db, {
    resourceType: "remote_agent",
    resourceId: params.remoteAgentId,
    workspaceId: params.workspaceId,
    grantedToMemberId: requester.workspaceMemberId,
    grantedByWorkspaceMemberId: params.grantedByWorkspaceMemberId ?? null,
  })
  await ensureFriendEntry({
    workspaceId: params.workspaceId,
    ownerWorkspaceMemberId: requester.workspaceMemberId,
    peerType: "remote_agent",
    peerRemoteAgentId: params.remoteAgentId,
  })
}

async function ensureFriendEntry(params: {
  workspaceId: string
  ownerWorkspaceMemberId: string
  peerType: ContactTargetType
  peerWorkspaceMemberId?: string
  peerActorId?: string
  peerRemoteAgentId?: string
  sourceRequestId?: string
}) {
  const peerSubjectRef = buildRelationshipPeerSubjectRef({
    peerType: params.peerType,
    peerWorkspaceMemberId: params.peerWorkspaceMemberId,
    peerActorId: params.peerActorId,
    peerRemoteAgentId: params.peerRemoteAgentId,
  })
  const peerSubjectId = await upsertAccessSubject(db, peerSubjectRef)
  await db
    .insertInto("workspace_friend_entries")
    .values({
      workspace_id: params.workspaceId,
      owner_workspace_member_id: params.ownerWorkspaceMemberId,
      peer_subject_id: peerSubjectId,
      source_request_id: params.sourceRequestId || null,
    })
    .onConflict((oc) => oc.doNothing())
    .execute()
}

async function findExistingFriendEntry(params: {
  workspaceId: string
  ownerWorkspaceMemberId: string
  peerType: ContactTargetType
  peerWorkspaceMemberId?: string
  peerActorId?: string
  peerRemoteAgentId?: string
}) {
  const peerSubjectRef = buildRelationshipPeerSubjectRef({
    peerType: params.peerType,
    peerWorkspaceMemberId: params.peerWorkspaceMemberId,
    peerActorId: params.peerActorId,
    peerRemoteAgentId: params.peerRemoteAgentId,
  })
  const peerSubjectId = await upsertAccessSubject(db, peerSubjectRef)
  const queryBuilder = db
    .selectFrom("workspace_friend_entries as e")
    .innerJoin("access_subjects as s", "s.id", "e.peer_subject_id")
    .select([
      "e.id",
      "e.workspace_id",
      "e.owner_workspace_member_id",
      "e.peer_subject_id",
      "e.source_request_id",
      "e.created_at",
      "e.updated_at",
      "s.workspace_member_id as peer_workspace_member_id",
      "s.actor_id as peer_actor_id",
      "s.remote_agent_id as peer_remote_agent_id",
      "s.kind as peer_kind",
    ])
    .where("e.workspace_id", "=", params.workspaceId)
    .where("e.owner_workspace_member_id", "=", params.ownerWorkspaceMemberId)
    .where("e.peer_subject_id", "=", peerSubjectId)
  return queryBuilder.executeTakeFirst()
}

async function findPendingFriendRequest(params: {
  requesterWorkspaceMemberId: string
  targetType: ContactTargetType
  targetWorkspaceMemberId?: string
  targetActorId?: string
  targetRemoteAgentId?: string
}) {
  const targetSubjectRef = buildRelationshipPeerSubjectRef({
    peerType: params.targetType,
    peerWorkspaceMemberId: params.targetWorkspaceMemberId,
    peerActorId: params.targetActorId,
    peerRemoteAgentId: params.targetRemoteAgentId,
  })
  const targetSubjectId = await upsertAccessSubject(db, targetSubjectRef)
  const queryBuilder = db
    .selectFrom("workspace_friend_requests as r")
    .innerJoin("access_subjects as s", "s.id", "r.target_subject_id")
    .select([
      "r.id",
      "r.requester_workspace_member_id",
      "r.target_subject_id",
      "r.requested_via_profile_id",
      "r.status",
      "r.resolved_by_workspace_member_id",
      "r.resolved_at",
      "r.created_at",
      "r.updated_at",
      "s.kind as target_kind",
      "s.workspace_member_id as target_workspace_member_id",
      "s.actor_id as target_actor_id",
      "s.remote_agent_id as target_remote_agent_id",
    ])
    .where(
      "r.requester_workspace_member_id",
      "=",
      params.requesterWorkspaceMemberId
    )
    .where("r.target_subject_id", "=", targetSubjectId)
    .where("r.status", "=", "pending")
  return queryBuilder.executeTakeFirst()
}

async function createFriendRequest(params: {
  requesterWorkspaceMemberId: string
  targetType: ContactTargetType
  targetWorkspaceMemberId?: string
  targetActorId?: string
  targetRemoteAgentId?: string
  profileId?: string
}) {
  const existing = await findPendingFriendRequest(params)
  if (existing) {
    return { request: existing, created: false as const }
  }
  try {
    const targetSubjectRef = buildRelationshipPeerSubjectRef({
      peerType: params.targetType,
      peerWorkspaceMemberId: params.targetWorkspaceMemberId,
      peerActorId: params.targetActorId,
      peerRemoteAgentId: params.targetRemoteAgentId,
    })
    const targetSubjectId = await upsertAccessSubject(db, targetSubjectRef)
    const created = await db
      .insertInto("workspace_friend_requests")
      .values({
        requester_workspace_member_id: params.requesterWorkspaceMemberId,
        target_subject_id: targetSubjectId,
        requested_via_profile_id: params.profileId || null,
        status: "pending",
      })
      .returningAll()
      .executeTakeFirst()
    if (!created) {
      throw new Error("Failed to create friend request")
    }
    return { request: created, created: true as const }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const retry = await findPendingFriendRequest(params)
    if (!retry) throw error
    return { request: retry, created: false as const }
  }
}

async function createActorAccessRequest(params: {
  workspaceId: string
  actorId: string
  requesterWorkspaceMemberId: string
}) {
  // P2/P1b: actor + remote_agent access requests live in the merged
  // entity_access_requests table keyed by target_subject_id.
  const targetSubjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.ACTOR,
    actorId: params.actorId,
  })
  const existing = await db
    .selectFrom("entity_access_requests")
    .selectAll()
    .where("workspace_id", "=", params.workspaceId)
    .where("target_subject_id", "=", targetSubjectId)
    .where(
      "requester_workspace_member_id",
      "=",
      params.requesterWorkspaceMemberId
    )
    .where("status", "=", "pending")
    .executeTakeFirst()
  if (existing) {
    return {
      request: { ...existing, actor_id: params.actorId },
      created: false as const,
    }
  }

  try {
    const created = await db
      .insertInto("entity_access_requests")
      .values({
        workspace_id: params.workspaceId,
        target_subject_id: targetSubjectId,
        requester_workspace_member_id: params.requesterWorkspaceMemberId,
        status: "pending",
      })
      .returningAll()
      .executeTakeFirst()
    if (!created) {
      throw new Error("Failed to create actor access request")
    }
    return {
      request: { ...created, actor_id: params.actorId },
      created: true as const,
    }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const retry = await db
      .selectFrom("entity_access_requests")
      .selectAll()
      .where("workspace_id", "=", params.workspaceId)
      .where("target_subject_id", "=", targetSubjectId)
      .where(
        "requester_workspace_member_id",
        "=",
        params.requesterWorkspaceMemberId
      )
      .where("status", "=", "pending")
      .executeTakeFirst()
    if (!retry) throw error
    return {
      request: { ...retry, actor_id: params.actorId },
      created: false as const,
    }
  }
}

async function createRemoteAgentAccessRequest(params: {
  workspaceId: string
  remoteAgentId: string
  requesterWorkspaceMemberId: string
}) {
  const targetSubjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.REMOTE_AGENT,
    remoteAgentId: params.remoteAgentId,
  })
  const existing = await db
    .selectFrom("entity_access_requests")
    .selectAll()
    .where("workspace_id", "=", params.workspaceId)
    .where("target_subject_id", "=", targetSubjectId)
    .where(
      "requester_workspace_member_id",
      "=",
      params.requesterWorkspaceMemberId
    )
    .where("status", "=", "pending")
    .executeTakeFirst()
  if (existing) {
    return {
      request: { ...existing, remote_agent_id: params.remoteAgentId },
      created: false as const,
    }
  }

  try {
    const created = await db
      .insertInto("entity_access_requests")
      .values({
        workspace_id: params.workspaceId,
        target_subject_id: targetSubjectId,
        requester_workspace_member_id: params.requesterWorkspaceMemberId,
        status: "pending",
      })
      .returningAll()
      .executeTakeFirst()
    if (!created) {
      throw new Error("Failed to create remote agent access request")
    }
    return {
      request: { ...created, remote_agent_id: params.remoteAgentId },
      created: true as const,
    }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const retry = await db
      .selectFrom("entity_access_requests")
      .selectAll()
      .where("workspace_id", "=", params.workspaceId)
      .where("target_subject_id", "=", targetSubjectId)
      .where(
        "requester_workspace_member_id",
        "=",
        params.requesterWorkspaceMemberId
      )
      .where("status", "=", "pending")
      .executeTakeFirst()
    if (!retry) throw error
    return {
      request: { ...retry, remote_agent_id: params.remoteAgentId },
      created: false as const,
    }
  }
}

async function loadViewerDirectConversationMap(workspaceMemberId: string) {
  // P1b: filter by the viewer's workspace_member subject_id (resolved via
  // upsertAccessSubject), not the dropped participant_*_workspace_member_id
  // columns.
  const viewerSubjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    memberId: workspaceMemberId,
  })
  const rows = await db
    .selectFrom("direct_conversation_bindings")
    .selectAll()
    .where((eb) =>
      eb.or([
        eb("participant_one_subject_id", "=", viewerSubjectId),
        eb("participant_two_subject_id", "=", viewerSubjectId),
      ])
    )
    .execute()

  const viewerIdentity: DirectConversationIdentity = {
    kind: "workspace_member",
    workspaceMemberId,
  }
  const map = new Map<string, string>()
  for (const row of rows) {
    const peer = await directConversationBindingPeer(db, row, viewerIdentity)
    if (!peer) continue
    map.set(directConversationIdentityKey(peer), row.conversation_id)
  }
  return map
}

async function findDirectConversationId(
  left: DirectConversationIdentity,
  right: DirectConversationIdentity
) {
  const pair = canonicalizeDirectConversationPair(left, right)
  const values = await directConversationBindingValues(db, pair)
  const row = await db
    .selectFrom("direct_conversation_bindings")
    .select(["conversation_id"])
    .where("participant_one_subject_id", "=", values.participant_one_subject_id)
    .where("participant_two_subject_id", "=", values.participant_two_subject_id)
    .executeTakeFirst()
  return row?.conversation_id || null
}

async function getActorAccessState(params: {
  workspaceId: string
  userId: string
  actor: ActorSummary
  conversationId?: string
  pendingRequestActorIds: Set<string>
}) {
  if (params.conversationId) return CONTACT_DIRECT_STATE.EXISTING
  const canInvoke = await authorizeAction(db, {
    subject: await resolveWorkspaceAccessSubject(
      db,
      params.workspaceId,
      params.userId
    ),
    action: "actor.invoke",
    resourceId: params.actor.actorId,
  })
  // P2 contract: the `accessPolicy === WORKSPACE_OPEN` fallback was deleted —
  // the evaluator's `actor.invoke` now consults the binding directly, including
  // the auto-written workspace-scoped default_open binding for open actors.
  if (canInvoke) {
    return CONTACT_DIRECT_STATE.AVAILABLE
  }
  if (params.pendingRequestActorIds.has(params.actor.actorId)) {
    return CONTACT_DIRECT_STATE.PENDING_APPROVAL
  }
  return CONTACT_DIRECT_STATE.APPROVAL_REQUIRED
}

async function getRemoteAgentAccessState(params: {
  workspaceId: string
  userId: string
  remoteAgent: RemoteAgentSummary
  conversationId?: string
  pendingRequestRemoteAgentIds: Set<string>
}) {
  if (params.conversationId) return CONTACT_DIRECT_STATE.EXISTING
  const canInvoke = await authorizeAction(db, {
    subject: await resolveWorkspaceAccessSubject(
      db,
      params.workspaceId,
      params.userId
    ),
    action: "remote_agent.invoke",
    resourceId: params.remoteAgent.remoteAgentId,
  })
  // P2 contract (parity with getActorAccessState): the WORKSPACE_OPEN fallback
  // was deleted. The evaluator's `remote_agent.invoke` consults bindings only,
  // including the auto-written workspace-scoped default_open binding for open
  // remote agents.
  if (canInvoke) {
    return CONTACT_DIRECT_STATE.AVAILABLE
  }
  if (
    params.pendingRequestRemoteAgentIds.has(params.remoteAgent.remoteAgentId)
  ) {
    return CONTACT_DIRECT_STATE.PENDING_APPROVAL
  }
  return CONTACT_DIRECT_STATE.APPROVAL_REQUIRED
}

async function resolveContactReference(params: {
  workspaceId: string
  userId: string
  contactKind: ContactHubKind
  contactId: string
}) {
  const viewer = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )

  if (params.contactKind === "workspace-member") {
    const member = await getWorkspaceMemberSummaryById(params.contactId)
    if (!member || member.workspace.id !== params.workspaceId) {
      throw new Error("Workspace member not found")
    }
    if (viewer && member.workspaceMemberId === viewer.workspaceMemberId) {
      throw new Error("Cannot open a direct conversation with yourself")
    }
    return {
      kind: params.contactKind,
      member,
      peerIdentity: {
        kind: "workspace_member" as const,
        workspaceMemberId: member.workspaceMemberId,
      },
    }
  }

  if (params.contactKind === "workspace-actor") {
    const actor = await getActorSummary(params.contactId)
    if (!actor || actor.workspace.id !== params.workspaceId) {
      throw new Error("Actor not found")
    }
    return {
      kind: params.contactKind,
      actor,
      peerIdentity: {
        kind: "actor" as const,
        actorId: actor.actorId,
      },
    }
  }

  if (params.contactKind === "workspace-remote-agent") {
    const remoteAgent = await getRemoteAgentSummary(params.contactId)
    if (!remoteAgent || remoteAgent.workspace.id !== params.workspaceId) {
      throw new Error("Remote agent not found")
    }
    return {
      kind: params.contactKind,
      remoteAgent,
      peerIdentity: {
        kind: "remote_agent" as const,
        remoteAgentId: remoteAgent.remoteAgentId,
      },
    }
  }

  const friendEntry = await db
    .selectFrom("workspace_friend_entries as e")
    .innerJoin("access_subjects as s", "s.id", "e.peer_subject_id")
    .select([
      "e.id",
      "e.workspace_id",
      "e.owner_workspace_member_id",
      "e.peer_subject_id",
      "e.source_request_id",
      "e.created_at",
      "e.updated_at",
      "s.workspace_member_id as peer_workspace_member_id",
      "s.actor_id as peer_actor_id",
      "s.remote_agent_id as peer_remote_agent_id",
      "s.kind as peer_kind",
    ])
    .where("e.workspace_id", "=", params.workspaceId)
    .where("e.owner_workspace_member_id", "=", viewer?.workspaceMemberId || "")
    .where("e.id", "=", params.contactId)
    .executeTakeFirst()
  if (!friendEntry) {
    throw new Error("Friend not found")
  }

  if (params.contactKind === "friend-member") {
    if (!friendEntry.peer_workspace_member_id) {
      throw new Error("Friend not found")
    }
    const member = await getWorkspaceMemberSummaryById(
      friendEntry.peer_workspace_member_id
    )
    if (!member) {
      throw new Error("Friend not found")
    }
    return {
      kind: params.contactKind,
      friendEntry,
      member,
      peerIdentity: {
        kind: "workspace_member" as const,
        workspaceMemberId: member.workspaceMemberId,
      },
    }
  }

  if (params.contactKind === "friend-remote-agent") {
    if (!friendEntry.peer_remote_agent_id) {
      throw new Error("Friend not found")
    }
    const remoteAgent = await getRemoteAgentSummary(
      friendEntry.peer_remote_agent_id
    )
    if (!remoteAgent) {
      throw new Error("Friend not found")
    }
    return {
      kind: params.contactKind,
      friendEntry,
      remoteAgent,
      peerIdentity: {
        kind: "remote_agent" as const,
        remoteAgentId: remoteAgent.remoteAgentId,
      },
    }
  }

  if (!friendEntry.peer_actor_id) {
    throw new Error("Friend not found")
  }
  const actor = await getActorSummary(friendEntry.peer_actor_id)
  if (!actor) {
    throw new Error("Friend not found")
  }
  return {
    kind: params.contactKind,
    friendEntry,
    actor,
    peerIdentity: {
      kind: "actor" as const,
      actorId: actor.actorId,
    },
  }
}

async function buildContactHubEntryMap(params: {
  workspaceId: string
  userId: string
}) {
  const viewerWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  const directConversationMap = viewerWorkspaceMember
    ? await loadViewerDirectConversationMap(
        viewerWorkspaceMember.workspaceMemberId
      )
    : new Map<string, string>()
  const [
    members,
    actors,
    remoteAgentsResult,
    friendEntries,
    pendingActorAccessRows,
    pendingRemoteAgentAccessRows,
  ] = await Promise.all([
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
      .leftJoin(
        "file_assets as avatar_file",
        "avatar_file.id",
        "a.avatar_file_id"
      )
      .select([
        "a.id as actor_id",
        "a.workspace_id",
        "w.name as workspace_name",
        "w.slug as workspace_slug",
        "a.name",
        "a.title",
        "a.role",
        "a.is_public_shared",
        "a.avatar_emoji",
        "avatar_file.id as avatar_file_id",
      ])
      .where("a.workspace_id", "=", params.workspaceId)
      .where("a.is_active", "=", true)
      .orderBy("a.name", "asc")
      .execute(),
    executeSql<{
      remote_agent_id: string
      workspace_id: string
      workspace_name: string
      workspace_slug: string
      name: string
      title: string
      runtime_kind: "claude_code" | "codex"
      is_public_shared: boolean
      avatar_emoji: string | null
      avatar_file_id: string | null
    }>(
      `
          SELECT
            ra.id AS remote_agent_id,
            ra.workspace_id,
            w.name AS workspace_name,
            w.slug AS workspace_slug,
            ra.name,
            ra.title,
            ra.runtime_kind,
            ra.is_public_shared,
            ra.avatar_emoji,
            ra.avatar_file_id
          FROM remote_agents ra
          INNER JOIN workspaces w ON w.id = ra.workspace_id
          WHERE ra.workspace_id = $1
            AND ra.is_active = TRUE
          ORDER BY ra.name ASC, ra.created_at ASC
        `,
      [params.workspaceId]
    ),
    db
      .selectFrom("workspace_friend_entries as e")
      .innerJoin("access_subjects as s", "s.id", "e.peer_subject_id")
      .select([
        "e.id",
        "e.workspace_id",
        "e.owner_workspace_member_id",
        "e.peer_subject_id",
        "e.source_request_id",
        "e.created_at",
        "e.updated_at",
        "s.workspace_member_id as peer_workspace_member_id",
        "s.actor_id as peer_actor_id",
        "s.remote_agent_id as peer_remote_agent_id",
        "s.kind as peer_kind",
      ])
      .where("e.workspace_id", "=", params.workspaceId)
      .where(
        "e.owner_workspace_member_id",
        "=",
        viewerWorkspaceMember?.workspaceMemberId || ""
      )
      .orderBy("created_at", "desc")
      .execute(),
    viewerWorkspaceMember
      ? db
          .selectFrom("entity_access_requests as ear")
          .innerJoin(
            "access_subjects as subj",
            "subj.id",
            "ear.target_subject_id"
          )
          .select(["subj.actor_id"])
          .where("ear.workspace_id", "=", params.workspaceId)
          .where(
            "ear.requester_workspace_member_id",
            "=",
            viewerWorkspaceMember.workspaceMemberId
          )
          .where("ear.status", "=", "pending")
          .where("subj.kind", "=", "actor")
          .execute()
      : Promise.resolve([]),
    viewerWorkspaceMember
      ? db
          .selectFrom("entity_access_requests as ear")
          .innerJoin(
            "access_subjects as subj",
            "subj.id",
            "ear.target_subject_id"
          )
          .select(["subj.remote_agent_id"])
          .where("ear.workspace_id", "=", params.workspaceId)
          .where(
            "ear.requester_workspace_member_id",
            "=",
            viewerWorkspaceMember.workspaceMemberId
          )
          .where("ear.status", "=", "pending")
          .where("subj.kind", "=", "remote_agent")
          .execute()
      : Promise.resolve([]),
  ])

  const pendingActorAccessIds = new Set(
    pendingActorAccessRows
      .map((row) => row.actor_id)
      .filter((id): id is string => !!id)
  )
  const pendingRemoteAgentAccessIds = new Set(
    pendingRemoteAgentAccessRows
      .map((row) => row.remote_agent_id)
      .filter((id): id is string => !!id)
  )

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
          kind: "workspace_member",
          workspaceMemberId: row.workspace_member_id,
        })
      ),
    })
  )

  const actorPolicies = await deriveAccessPolicyMany(
    db,
    "actor",
    params.workspaceId,
    actors.map((row) => row.actor_id)
  )
  const workspaceActors: ContactHubEntry[] = []
  for (const row of actors) {
    const actor: ActorSummary = {
      workspace: workspaceSummary(row),
      actorId: row.actor_id,
      name: row.name,
      title: row.title,
      role: row.role,
      avatarFileId: row.avatar_file_id,
      avatarEmoji: row.avatar_emoji,
      accessPolicy:
        actorPolicies.get(row.actor_id) ??
        RELATIONSHIP_ACCESS_POLICY.APPROVAL_REQUIRED,
      isPublicShared: Boolean(row.is_public_shared),
    }
    const conversationId = directConversationMap.get(
      directConversationIdentityKey({
        kind: "actor",
        actorId: actor.actorId,
      })
    )
    const accessState = await getActorAccessState({
      workspaceId: params.workspaceId,
      userId: params.userId,
      actor,
      conversationId,
      pendingRequestActorIds: pendingActorAccessIds,
    })
    workspaceActors.push(
      mapWorkspaceActorEntry({
        actor,
        conversationId,
        accessState,
      })
    )
  }

  const remoteAgentPolicies = await deriveAccessPolicyMany(
    db,
    "remote_agent",
    params.workspaceId,
    remoteAgentsResult.rows.map((row) => row.remote_agent_id)
  )
  const workspaceRemoteAgents: ContactHubEntry[] = []
  for (const row of remoteAgentsResult.rows) {
    const remoteAgent: RemoteAgentSummary = {
      workspace: workspaceSummary(row),
      remoteAgentId: row.remote_agent_id,
      name: row.name,
      title: row.title,
      runtimeKind: row.runtime_kind,
      avatarFileId: row.avatar_file_id,
      avatarEmoji: row.avatar_emoji,
      accessPolicy:
        remoteAgentPolicies.get(row.remote_agent_id) ??
        RELATIONSHIP_ACCESS_POLICY.APPROVAL_REQUIRED,
      isPublicShared: Boolean(row.is_public_shared),
    }
    const conversationId = directConversationMap.get(
      directConversationIdentityKey({
        kind: "remote_agent",
        remoteAgentId: remoteAgent.remoteAgentId,
      })
    )
    const accessState = await getRemoteAgentAccessState({
      workspaceId: params.workspaceId,
      userId: params.userId,
      remoteAgent,
      conversationId,
      pendingRequestRemoteAgentIds: pendingRemoteAgentAccessIds,
    })
    workspaceRemoteAgents.push(
      mapWorkspaceRemoteAgentEntry({
        remoteAgent,
        conversationId,
        accessState,
      })
    )
  }

  const friends: ContactHubEntry[] = []
  for (const entry of friendEntries) {
    if (
      entry.peer_kind === "workspace_member" &&
      entry.peer_workspace_member_id
    ) {
      const peer = await getWorkspaceMemberSummaryById(
        entry.peer_workspace_member_id
      )
      if (!peer) continue
      friends.push(
        mapMemberFriendEntry({
          entryId: entry.id,
          peer,
          conversationId: directConversationMap.get(
            directConversationIdentityKey({
              kind: "workspace_member",
              workspaceMemberId: peer.workspaceMemberId,
            })
          ),
        })
      )
      continue
    }
    if (entry.peer_kind === "actor" && entry.peer_actor_id) {
      const actor = await getActorSummary(entry.peer_actor_id)
      if (!actor) continue
      friends.push(
        mapActorFriendEntry({
          entryId: entry.id,
          actor,
          conversationId: directConversationMap.get(
            directConversationIdentityKey({
              kind: "actor",
              actorId: entry.peer_actor_id,
            })
          ),
        })
      )
      continue
    }
    if (entry.peer_kind === "remote_agent" && entry.peer_remote_agent_id) {
      const remoteAgent = await getRemoteAgentSummary(
        entry.peer_remote_agent_id
      )
      if (!remoteAgent) continue
      friends.push(
        mapRemoteAgentFriendEntry({
          entryId: entry.id,
          remoteAgent,
          conversationId: directConversationMap.get(
            directConversationIdentityKey({
              kind: "remote_agent",
              remoteAgentId: entry.peer_remote_agent_id,
            })
          ),
        })
      )
    }
  }

  return {
    workspaceMembers,
    workspaceActors,
    workspaceRemoteAgents,
    friends,
  }
}

async function createOrApproveFriendship(params: {
  requesterWorkspaceMemberId: string
  targetType: ContactTargetType
  targetWorkspaceMemberId?: string
  targetActorId?: string
  targetRemoteAgentId?: string
  sourceRequestId?: string
}) {
  const requester = await getWorkspaceMemberSummaryById(
    params.requesterWorkspaceMemberId
  )
  if (!requester) {
    throw new Error("Requester workspace member not found")
  }

  await ensureFriendEntry({
    workspaceId: requester.workspace.id,
    ownerWorkspaceMemberId: requester.workspaceMemberId,
    peerType: params.targetType,
    peerWorkspaceMemberId: params.targetWorkspaceMemberId,
    peerActorId: params.targetActorId,
    peerRemoteAgentId: params.targetRemoteAgentId,
    sourceRequestId: params.sourceRequestId,
  })

  if (
    params.targetType === CONTACT_TARGET_TYPE.MEMBER &&
    params.targetWorkspaceMemberId
  ) {
    const target = await getWorkspaceMemberSummaryById(
      params.targetWorkspaceMemberId
    )
    if (!target) {
      throw new Error("Target workspace member not found")
    }
    await ensureFriendEntry({
      workspaceId: target.workspace.id,
      ownerWorkspaceMemberId: target.workspaceMemberId,
      peerType: "workspace_member",
      peerWorkspaceMemberId: requester.workspaceMemberId,
      sourceRequestId: params.sourceRequestId,
    })
  }
}

async function resolveMemberRelationshipProfile(params: {
  workspaceId: string
  userId: string
  viewerWorkspaceMemberId: string
  profile: {
    id: string
    workspace_id: string
    subject_type: string
    subject_workspace_member_id: string | null
    approval_mode: ApprovalMode
  }
}) {
  if (
    !params.profile.subject_workspace_member_id ||
    params.profile.subject_workspace_member_id ===
      params.viewerWorkspaceMemberId
  ) {
    return { outcome: "self_scan" as const }
  }

  const member = await getWorkspaceMemberSummaryById(
    params.profile.subject_workspace_member_id
  )
  if (!member) {
    throw new Error("Relationship profile target not found")
  }

  if (params.profile.workspace_id === params.workspaceId) {
    return {
      outcome: "same_workspace_member" as const,
      contact: {
        kind: "workspace-member" as const,
        id: member.workspaceMemberId,
      },
    }
  }

  const existingFriend = await findExistingFriendEntry({
    workspaceId: params.workspaceId,
    ownerWorkspaceMemberId: params.viewerWorkspaceMemberId,
    peerType: "workspace_member",
    peerWorkspaceMemberId: params.profile.subject_workspace_member_id,
  })
  if (existingFriend) {
    return {
      outcome: "friend_active" as const,
      contact: {
        kind: "friend-member" as const,
        id: existingFriend.id,
      },
    }
  }

  if (params.profile.approval_mode === "auto") {
    await createOrApproveFriendship({
      requesterWorkspaceMemberId: params.viewerWorkspaceMemberId,
      targetType: "workspace_member",
      targetWorkspaceMemberId: params.profile.subject_workspace_member_id,
    })
    const entry = await findExistingFriendEntry({
      workspaceId: params.workspaceId,
      ownerWorkspaceMemberId: params.viewerWorkspaceMemberId,
      peerType: "workspace_member",
      peerWorkspaceMemberId: params.profile.subject_workspace_member_id,
    })
    return {
      outcome: "friend_active" as const,
      contact: entry
        ? {
            kind: "friend-member" as const,
            id: entry.id,
          }
        : undefined,
    }
  }

  const requestResult = await createFriendRequest({
    requesterWorkspaceMemberId: params.viewerWorkspaceMemberId,
    targetType: "workspace_member",
    targetWorkspaceMemberId: params.profile.subject_workspace_member_id,
    profileId: params.profile.id,
  })
  return {
    outcome: requestResult.created
      ? ("friend_request_created" as const)
      : ("friend_request_pending" as const),
    requestId: requestResult.request.id,
  }
}

export async function searchRelationshipsByIdentity(params: {
  workspaceId: string
  userId: string
  query: string
}) {
  const normalizedQuery = normalizeIdentityId(params.query)
  if (!normalizedQuery) {
    return {
      query: normalizedQuery,
      outcome: "empty" as IdentitySearchOutcome,
      matches: [],
    }
  }
  if (!IDENTITY_ID_PATTERN.test(normalizedQuery)) {
    return {
      query: normalizedQuery,
      outcome: "invalid" as IdentitySearchOutcome,
      matches: [],
    }
  }

  const viewerWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  if (!viewerWorkspaceMember) {
    throw new Error("Workspace member not found")
  }

  const profile = await db
    .selectFrom("workspace_relationship_profiles as p")
    .innerJoin("access_subjects as s", "s.id", "p.subject_id")
    .select([
      "p.id",
      "p.workspace_id",
      "p.subject_id",
      "p.identity_id",
      "p.identity_search_enabled",
      "p.approval_mode",
      "p.qr_token",
      "p.created_by_workspace_member_id",
      "p.created_at",
      "p.updated_at",
      "s.kind as subject_type",
      "s.workspace_member_id as subject_workspace_member_id",
      "s.actor_id as subject_actor_id",
      "s.remote_agent_id as subject_remote_agent_id",
    ])
    .where("p.identity_id", "=", normalizedQuery)
    .where("p.identity_search_enabled", "=", true)
    .executeTakeFirst()
  if (!profile) {
    return {
      query: normalizedQuery,
      outcome: "not_found" as IdentitySearchOutcome,
      matches: [],
    }
  }

  const directConversationMap = await loadViewerDirectConversationMap(
    viewerWorkspaceMember.workspaceMemberId
  )

  if (profile.subject_type === "workspace_member") {
    if (
      profile.subject_workspace_member_id ===
      viewerWorkspaceMember.workspaceMemberId
    ) {
      return {
        query: normalizedQuery,
        outcome: "self" as IdentitySearchOutcome,
        matches: [],
      }
    }

    const member = profile.subject_workspace_member_id
      ? await getWorkspaceMemberSummaryById(profile.subject_workspace_member_id)
      : null
    if (!member) {
      return {
        query: normalizedQuery,
        outcome: "not_found" as IdentitySearchOutcome,
        matches: [],
      }
    }

    const conversationId = directConversationMap.get(
      directConversationIdentityKey({
        kind: "workspace_member",
        workspaceMemberId: member.workspaceMemberId,
      })
    )

    if (member.workspace.id === params.workspaceId) {
      return {
        query: normalizedQuery,
        outcome: "found" as IdentitySearchOutcome,
        matches: [
          {
            profileId: profile.id,
            targetType: "workspace_member" as const,
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
      }
    }

    const existingFriend = await findExistingFriendEntry({
      workspaceId: params.workspaceId,
      ownerWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
      peerType: "workspace_member",
      peerWorkspaceMemberId: member.workspaceMemberId,
    })
    if (existingFriend) {
      return {
        query: normalizedQuery,
        outcome: "found" as IdentitySearchOutcome,
        matches: [
          {
            profileId: profile.id,
            targetType: "workspace_member" as const,
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
      }
    }

    const pendingRequest = await findPendingFriendRequest({
      requesterWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
      targetType: "workspace_member",
      targetWorkspaceMemberId: member.workspaceMemberId,
    })
    return {
      query: normalizedQuery,
      outcome: "found" as IdentitySearchOutcome,
      matches: [
        {
          profileId: profile.id,
          targetType: "workspace_member" as const,
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
    }
  }

  if (profile.subject_type === "remote_agent") {
    const remoteAgent = profile.subject_remote_agent_id
      ? await getRemoteAgentSummary(profile.subject_remote_agent_id)
      : null
    if (!remoteAgent) {
      return {
        query: normalizedQuery,
        outcome: "not_found" as IdentitySearchOutcome,
        matches: [],
      }
    }

    const conversationId = directConversationMap.get(
      directConversationIdentityKey({
        kind: "remote_agent",
        remoteAgentId: remoteAgent.remoteAgentId,
      })
    )

    if (remoteAgent.workspace.id === params.workspaceId) {
      const remoteAgentSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.REMOTE_AGENT,
        remoteAgentId: remoteAgent.remoteAgentId,
      })
      const pendingRemoteAgentRequest = await executeSql<{ id: string }>(
        `
          SELECT id
          FROM entity_access_requests
          WHERE workspace_id = $1
            AND target_subject_id = $2
            AND requester_workspace_member_id = $3
            AND status = 'pending'
          LIMIT 1
        `,
        [
          params.workspaceId,
          remoteAgentSubjectId,
          viewerWorkspaceMember.workspaceMemberId,
        ]
      )
      const accessState = await getRemoteAgentAccessState({
        workspaceId: params.workspaceId,
        userId: params.userId,
        remoteAgent,
        conversationId,
        pendingRequestRemoteAgentIds: new Set(
          pendingRemoteAgentRequest.rows[0] ? [remoteAgent.remoteAgentId] : []
        ),
      })
      return {
        query: normalizedQuery,
        outcome: "found" as IdentitySearchOutcome,
        matches: [
          {
            profileId: profile.id,
            targetType: "remote_agent" as const,
            title: remoteAgent.name,
            subtitle: `${remoteAgent.workspace.name} · ${remoteAgent.title}`,
            avatarUrl: remoteAgent.avatarFileId
              ? getFileUrlById(remoteAgent.avatarFileId)
              : undefined,
            avatarEmoji: remoteAgent.avatarEmoji || undefined,
            workspace: remoteAgent.workspace,
            remoteAgentId: remoteAgent.remoteAgentId,
            state: accessState,
            contact: {
              kind: "workspace-remote-agent" as const,
              id: remoteAgent.remoteAgentId,
            },
            conversationId,
            requestId: pendingRemoteAgentRequest.rows[0]?.id,
          },
        ],
      }
    }

    const existingFriend = await findExistingFriendEntry({
      workspaceId: params.workspaceId,
      ownerWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
      peerType: "remote_agent",
      peerRemoteAgentId: remoteAgent.remoteAgentId,
    })
    if (existingFriend) {
      return {
        query: normalizedQuery,
        outcome: "found" as IdentitySearchOutcome,
        matches: [
          {
            profileId: profile.id,
            targetType: "remote_agent" as const,
            title: remoteAgent.name,
            subtitle: `${remoteAgent.workspace.name} · ${remoteAgent.title}`,
            avatarUrl: remoteAgent.avatarFileId
              ? getFileUrlById(remoteAgent.avatarFileId)
              : undefined,
            avatarEmoji: remoteAgent.avatarEmoji || undefined,
            workspace: remoteAgent.workspace,
            remoteAgentId: remoteAgent.remoteAgentId,
            state: "friend" as const,
            contact: {
              kind: "friend-remote-agent" as const,
              id: existingFriend.id,
            },
            conversationId,
          },
        ],
      }
    }

    const pendingRequest = await findPendingFriendRequest({
      requesterWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
      targetType: "remote_agent",
      targetRemoteAgentId: remoteAgent.remoteAgentId,
    })
    return {
      query: normalizedQuery,
      outcome: "found" as IdentitySearchOutcome,
      matches: [
        {
          profileId: profile.id,
          targetType: "remote_agent" as const,
          title: remoteAgent.name,
          subtitle: `${remoteAgent.workspace.name} · ${remoteAgent.title}`,
          avatarUrl: remoteAgent.avatarFileId
            ? getFileUrlById(remoteAgent.avatarFileId)
            : undefined,
          avatarEmoji: remoteAgent.avatarEmoji || undefined,
          workspace: remoteAgent.workspace,
          remoteAgentId: remoteAgent.remoteAgentId,
          state: pendingRequest
            ? ("pending_request" as const)
            : ("requestable" as const),
          requestId: pendingRequest?.id,
        },
      ],
    }
  }

  const actor = profile.subject_actor_id
    ? await getActorSummary(profile.subject_actor_id)
    : null
  if (!actor) {
    return {
      query: normalizedQuery,
      outcome: "not_found" as IdentitySearchOutcome,
      matches: [],
    }
  }

  const conversationId = directConversationMap.get(
    directConversationIdentityKey({
      kind: "actor",
      actorId: actor.actorId,
    })
  )

  if (actor.workspace.id === params.workspaceId) {
    const actorSubjectId = await upsertAccessSubject(db, {
      kind: SUBJECT_KIND.ACTOR,
      actorId: actor.actorId,
    })
    const pendingActorRequest = await db
      .selectFrom("entity_access_requests")
      .select(["id"])
      .where("workspace_id", "=", params.workspaceId)
      .where("target_subject_id", "=", actorSubjectId)
      .where(
        "requester_workspace_member_id",
        "=",
        viewerWorkspaceMember.workspaceMemberId
      )
      .where("status", "=", "pending")
      .executeTakeFirst()
    const accessState = await getActorAccessState({
      workspaceId: params.workspaceId,
      userId: params.userId,
      actor,
      conversationId,
      pendingRequestActorIds: new Set(
        pendingActorRequest ? [actor.actorId] : []
      ),
    })
    return {
      query: normalizedQuery,
      outcome: "found" as IdentitySearchOutcome,
      matches: [
        {
          profileId: profile.id,
          targetType: "actor" as const,
          title: actor.name,
          subtitle: `${actor.workspace.name} · ${actor.title}`,
          avatarUrl: actor.avatarFileId
            ? getFileUrlById(actor.avatarFileId)
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
    }
  }

  const existingFriend = await findExistingFriendEntry({
    workspaceId: params.workspaceId,
    ownerWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
    peerType: "actor",
    peerActorId: actor.actorId,
  })
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
          avatarUrl: actor.avatarFileId
            ? getFileUrlById(actor.avatarFileId)
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
    }
  }

  const pendingRequest = await findPendingFriendRequest({
    requesterWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
    targetType: "actor",
    targetActorId: actor.actorId,
  })
  return {
    query: normalizedQuery,
    outcome: "found" as IdentitySearchOutcome,
    matches: [
      {
        profileId: profile.id,
        targetType: "actor" as const,
        title: actor.name,
        subtitle: `${actor.workspace.name} · ${actor.title}`,
        avatarUrl: actor.avatarFileId
          ? getFileUrlById(actor.avatarFileId)
          : undefined,
        avatarEmoji: actor.avatarEmoji || undefined,
        workspace: actor.workspace,
        actorId: actor.actorId,
        state: pendingRequest
          ? ("pending_request" as const)
          : ("requestable" as const),
        requestId: pendingRequest?.id,
      },
    ],
  }
}

export async function requestRelationshipByIdentityProfile(params: {
  workspaceId: string
  userId: string
  profileId: string
  requireSearchable?: boolean
}) {
  const viewerWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  if (!viewerWorkspaceMember) {
    throw new Error("Workspace member not found")
  }

  const profile = await db
    .selectFrom("workspace_relationship_profiles as p")
    .innerJoin("access_subjects as s", "s.id", "p.subject_id")
    .select([
      "p.id",
      "p.workspace_id",
      "p.subject_id",
      "p.identity_id",
      "p.identity_search_enabled",
      "p.approval_mode",
      "p.qr_token",
      "p.created_by_workspace_member_id",
      "p.created_at",
      "p.updated_at",
      "s.kind as subject_type",
      "s.workspace_member_id as subject_workspace_member_id",
      "s.actor_id as subject_actor_id",
      "s.remote_agent_id as subject_remote_agent_id",
    ])
    .where("p.id", "=", params.profileId)
    .executeTakeFirst()
  if (!profile) {
    throw new Error("Search target not found")
  }
  if (params.requireSearchable !== false && !profile.identity_search_enabled) {
    throw new Error("Search target not found")
  }

  if (profile.subject_type === "workspace_member") {
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
    })
  }

  if (profile.subject_type === "remote_agent") {
    const remoteAgent = profile.subject_remote_agent_id
      ? await getRemoteAgentSummary(profile.subject_remote_agent_id)
      : null
    if (!remoteAgent) {
      throw new Error("Relationship profile target not found")
    }

    if (profile.workspace_id === params.workspaceId) {
      const canInvoke = await authorizeAction(db, {
        subject: await resolveWorkspaceAccessSubject(
          db,
          params.workspaceId,
          params.userId
        ),
        action: "remote_agent.invoke",
        resourceId: remoteAgent.remoteAgentId,
      })

      // P2 contract: removed the WORKSPACE_OPEN-policy fallback —
      // evaluator already checks default_open binding via remote_agent grants.
      if (canInvoke) {
        return {
          outcome: "remote_agent_access_granted" as const,
          contact: {
            kind: "workspace-remote-agent" as const,
            id: remoteAgent.remoteAgentId,
          },
        }
      }

      if (profile.approval_mode === "auto") {
        await grantRemoteAgentAccess({
          workspaceId: params.workspaceId,
          remoteAgentId: remoteAgent.remoteAgentId,
          requesterWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
        })
        return {
          outcome: "remote_agent_access_granted" as const,
          contact: {
            kind: "workspace-remote-agent" as const,
            id: remoteAgent.remoteAgentId,
          },
        }
      }

      const requestResult = await createRemoteAgentAccessRequest({
        workspaceId: params.workspaceId,
        remoteAgentId: remoteAgent.remoteAgentId,
        requesterWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
      })
      return {
        outcome: requestResult.created
          ? ("remote_agent_access_request_created" as const)
          : ("remote_agent_access_pending" as const),
        requestId: requestResult.request.id,
        contact: {
          kind: "workspace-remote-agent" as const,
          id: remoteAgent.remoteAgentId,
        },
      }
    }

    const existingFriend = await findExistingFriendEntry({
      workspaceId: params.workspaceId,
      ownerWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
      peerType: "remote_agent",
      peerRemoteAgentId: remoteAgent.remoteAgentId,
    })
    if (existingFriend) {
      return {
        outcome: "friend_active" as const,
        contact: {
          kind: "friend-remote-agent" as const,
          id: existingFriend.id,
        },
      }
    }

    if (profile.approval_mode === "auto") {
      await createOrApproveFriendship({
        requesterWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
        targetType: "remote_agent",
        targetRemoteAgentId: remoteAgent.remoteAgentId,
      })
      const entry = await findExistingFriendEntry({
        workspaceId: params.workspaceId,
        ownerWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
        peerType: "remote_agent",
        peerRemoteAgentId: remoteAgent.remoteAgentId,
      })
      return {
        outcome: "friend_active" as const,
        contact: entry
          ? {
              kind: "friend-remote-agent" as const,
              id: entry.id,
            }
          : undefined,
      }
    }

    const requestResult = await createFriendRequest({
      requesterWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
      targetType: "remote_agent",
      targetRemoteAgentId: remoteAgent.remoteAgentId,
      profileId: profile.id,
    })
    return {
      outcome: requestResult.created
        ? ("friend_request_created" as const)
        : ("friend_request_pending" as const),
      requestId: requestResult.request.id,
    }
  }

  const actor = profile.subject_actor_id
    ? await getActorSummary(profile.subject_actor_id)
    : null
  if (!actor) {
    throw new Error("Relationship profile target not found")
  }

  if (profile.workspace_id === params.workspaceId) {
    const canInvoke = await authorizeAction(db, {
      subject: await resolveWorkspaceAccessSubject(
        db,
        params.workspaceId,
        params.userId
      ),
      action: "actor.invoke",
      resourceId: actor.actorId,
    })

    // P2 contract: removed the actor-WORKSPACE_OPEN policy fallback.
    if (canInvoke) {
      return {
        outcome: "actor_access_granted" as const,
        contact: {
          kind: "workspace-actor" as const,
          id: actor.actorId,
        },
      }
    }

    if (profile.approval_mode === "auto") {
      await grantActorAccess({
        workspaceId: params.workspaceId,
        actorId: actor.actorId,
        requesterWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
        grantedByWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
      })
      return {
        outcome: "actor_access_granted" as const,
        contact: {
          kind: "workspace-actor" as const,
          id: actor.actorId,
        },
      }
    }

    const requestResult = await createActorAccessRequest({
      workspaceId: params.workspaceId,
      actorId: actor.actorId,
      requesterWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
    })
    return {
      outcome: requestResult.created
        ? ("actor_access_request_created" as const)
        : ("actor_access_pending" as const),
      requestId: requestResult.request.id,
      contact: {
        kind: "workspace-actor" as const,
        id: actor.actorId,
      },
    }
  }

  const existingFriend = await findExistingFriendEntry({
    workspaceId: params.workspaceId,
    ownerWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
    peerType: "actor",
    peerActorId: actor.actorId,
  })
  if (existingFriend) {
    return {
      outcome: "friend_active" as const,
      contact: {
        kind: "friend-actor" as const,
        id: existingFriend.id,
      },
    }
  }

  if (profile.approval_mode === "auto") {
    await createOrApproveFriendship({
      requesterWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
      targetType: "actor",
      targetActorId: actor.actorId,
    })
    const entry = await findExistingFriendEntry({
      workspaceId: params.workspaceId,
      ownerWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
      peerType: "actor",
      peerActorId: actor.actorId,
    })
    return {
      outcome: "friend_active" as const,
      contact: entry
        ? {
            kind: "friend-actor" as const,
            id: entry.id,
          }
        : undefined,
    }
  }

  const requestResult = await createFriendRequest({
    requesterWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
    targetType: "actor",
    targetActorId: actor.actorId,
    profileId: profile.id,
  })
  return {
    outcome: requestResult.created
      ? ("friend_request_created" as const)
      : ("friend_request_pending" as const),
    requestId: requestResult.request.id,
  }
}

export async function getMemberRelationshipProfile(params: {
  workspaceId: string
  userId: string
}): Promise<RelationshipProfileView> {
  const viewerWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  if (!viewerWorkspaceMember) {
    throw new Error("Workspace member not found")
  }
  const profile = await ensureRelationshipProfile({
    workspaceId: params.workspaceId,
    createdByWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
    subjectType: RELATIONSHIP_PROFILE_SUBJECT_TYPE.MEMBER,
    subjectWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
  })
  return {
    subjectType: RELATIONSHIP_PROFILE_SUBJECT_TYPE.MEMBER,
    approvalMode: profile.approval_mode,
    qrToken: profile.qr_token,
    qrUrl: buildRelationshipQrUrl(profile.qr_token),
    identityId: profile.identity_id,
    identitySearchEnabled: profile.identity_search_enabled,
  }
}

export async function updateMemberRelationshipProfile(params: {
  workspaceId: string
  userId: string
  approvalMode: ApprovalMode
  identityId?: string
  identitySearchEnabled?: boolean
}): Promise<RelationshipProfileView> {
  const viewerWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  if (!viewerWorkspaceMember) {
    throw new Error("Workspace member not found")
  }
  const profile = await ensureRelationshipProfile({
    workspaceId: params.workspaceId,
    createdByWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
    subjectType: RELATIONSHIP_PROFILE_SUBJECT_TYPE.MEMBER,
    subjectWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
  })
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
      .executeTakeFirst()
    if (!updated) {
      throw new Error("Failed to update relationship profile")
    }
    return {
      subjectType: RELATIONSHIP_PROFILE_SUBJECT_TYPE.MEMBER,
      approvalMode: updated.approval_mode,
      qrToken: updated.qr_token,
      qrUrl: buildRelationshipQrUrl(updated.qr_token),
      identityId: updated.identity_id,
      identitySearchEnabled: updated.identity_search_enabled,
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new Error("This identity ID is already taken.")
    }
    throw error
  }
}

export async function getActorRelationshipProfile(params: {
  workspaceId: string
  actorId: string
  userId: string
}): Promise<RelationshipProfileView> {
  const actor = await getActorSummary(params.actorId)
  if (!actor || actor.workspace.id !== params.workspaceId) {
    throw new Error("Actor not found")
  }
  const viewerWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  if (!viewerWorkspaceMember) {
    throw new Error("Workspace member not found")
  }
  const profile = await ensureRelationshipProfile({
    workspaceId: params.workspaceId,
    createdByWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
    subjectType: RELATIONSHIP_PROFILE_SUBJECT_TYPE.ACTOR,
    subjectActorId: params.actorId,
  })
  return {
    subjectType: RELATIONSHIP_PROFILE_SUBJECT_TYPE.ACTOR,
    approvalMode: profile.approval_mode,
    qrToken: profile.qr_token,
    qrUrl: buildRelationshipQrUrl(profile.qr_token),
    identityId: profile.identity_id,
    identitySearchEnabled: profile.identity_search_enabled,
    accessPolicy: actor.accessPolicy,
    isPublicShared: actor.isPublicShared,
  }
}

export async function getRemoteAgentRelationshipProfile(params: {
  workspaceId: string
  remoteAgentId: string
  userId: string
}): Promise<RelationshipProfileView> {
  const remoteAgent = await getRemoteAgentSummary(params.remoteAgentId)
  if (!remoteAgent || remoteAgent.workspace.id !== params.workspaceId) {
    throw new Error("Remote agent not found")
  }
  const viewerWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  if (!viewerWorkspaceMember) {
    throw new Error("Workspace member not found")
  }
  const profile = await ensureRelationshipProfile({
    workspaceId: params.workspaceId,
    createdByWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
    subjectType: RELATIONSHIP_PROFILE_SUBJECT_TYPE.REMOTE_AGENT,
    subjectRemoteAgentId: params.remoteAgentId,
  })
  return {
    subjectType: RELATIONSHIP_PROFILE_SUBJECT_TYPE.REMOTE_AGENT,
    approvalMode: profile.approval_mode,
    qrToken: profile.qr_token,
    qrUrl: buildRelationshipQrUrl(profile.qr_token),
    identityId: profile.identity_id,
    identitySearchEnabled: profile.identity_search_enabled,
    accessPolicy: remoteAgent.accessPolicy,
    isPublicShared: remoteAgent.isPublicShared,
  }
}

export async function updateActorRelationshipProfile(params: {
  workspaceId: string
  actorId: string
  userId: string
  approvalMode: ApprovalMode
  identityId?: string
  identitySearchEnabled?: boolean
  accessPolicy?: AccessPolicy
  isPublicShared?: boolean
}): Promise<RelationshipProfileView> {
  const viewerWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  if (!viewerWorkspaceMember) {
    throw new Error("Workspace member not found")
  }
  const profile = await ensureRelationshipProfile({
    workspaceId: params.workspaceId,
    createdByWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
    subjectType: RELATIONSHIP_PROFILE_SUBJECT_TYPE.ACTOR,
    subjectActorId: params.actorId,
  })

  let updatedProfile
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
      .executeTakeFirst()
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new Error("This identity ID is already taken.")
    }
    throw error
  }
  if (!updatedProfile) {
    throw new Error("Failed to update relationship profile")
  }

  const actorSummary = await getActorSummary(params.actorId)
  let accessPolicy = actorSummary?.accessPolicy
  let isPublicShared = actorSummary?.isPublicShared ?? false
  if (params.accessPolicy) {
    const actorResult = await updateActorAccessPolicy({
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      updatedByWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
      accessPolicy: params.accessPolicy,
    })
    accessPolicy = actorResult.access_policy as AccessPolicy
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
      .executeTakeFirst()
    if (!actorResult) {
      throw new Error("Actor not found")
    }
    isPublicShared = Boolean(actorResult.is_public_shared)
  }

  return {
    subjectType: RELATIONSHIP_PROFILE_SUBJECT_TYPE.ACTOR,
    approvalMode: updatedProfile.approval_mode,
    qrToken: updatedProfile.qr_token,
    qrUrl: buildRelationshipQrUrl(updatedProfile.qr_token),
    identityId: updatedProfile.identity_id,
    identitySearchEnabled: updatedProfile.identity_search_enabled,
    accessPolicy: accessPolicy || RELATIONSHIP_ACCESS_POLICY.WORKSPACE_OPEN,
    isPublicShared,
  }
}

export async function updateRemoteAgentRelationshipProfile(params: {
  workspaceId: string
  remoteAgentId: string
  userId: string
  approvalMode: ApprovalMode
  identityId?: string
  identitySearchEnabled?: boolean
  accessPolicy?: AccessPolicy
  isPublicShared?: boolean
}): Promise<RelationshipProfileView> {
  const viewerWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  if (!viewerWorkspaceMember) {
    throw new Error("Workspace member not found")
  }
  const profile = await ensureRelationshipProfile({
    workspaceId: params.workspaceId,
    createdByWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
    subjectType: RELATIONSHIP_PROFILE_SUBJECT_TYPE.REMOTE_AGENT,
    subjectRemoteAgentId: params.remoteAgentId,
  })

  let updatedProfile
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
      .executeTakeFirst()
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new Error("This identity ID is already taken.")
    }
    throw error
  }
  if (!updatedProfile) {
    throw new Error("Failed to update relationship profile")
  }

  const remoteAgentSummary = await getRemoteAgentSummary(params.remoteAgentId)
  let accessPolicy = remoteAgentSummary?.accessPolicy
  let isPublicShared = remoteAgentSummary?.isPublicShared ?? false

  if (params.accessPolicy) {
    const remoteAgentResult = await updateRemoteAgentAccessPolicy({
      workspaceId: params.workspaceId,
      remoteAgentId: params.remoteAgentId,
      accessPolicy: params.accessPolicy,
    })
    accessPolicy = remoteAgentResult.access_policy
  }

  if (typeof params.isPublicShared === "boolean") {
    const updateResult = await executeSql<{ is_public_shared: boolean }>(
      `
        UPDATE remote_agents
        SET is_public_shared = $3,
            updated_at = NOW()
        WHERE id = $1
          AND workspace_id = $2
          AND is_active = TRUE
        RETURNING is_public_shared
      `,
      [params.remoteAgentId, params.workspaceId, params.isPublicShared]
    )
    if (!updateResult.rows[0]) {
      throw new Error("Remote agent not found")
    }
    isPublicShared = Boolean(updateResult.rows[0].is_public_shared)
  }

  return {
    subjectType: RELATIONSHIP_PROFILE_SUBJECT_TYPE.REMOTE_AGENT,
    approvalMode: updatedProfile.approval_mode,
    qrToken: updatedProfile.qr_token,
    qrUrl: buildRelationshipQrUrl(updatedProfile.qr_token),
    identityId: updatedProfile.identity_id,
    identitySearchEnabled: updatedProfile.identity_search_enabled,
    accessPolicy: accessPolicy || RELATIONSHIP_ACCESS_POLICY.WORKSPACE_OPEN,
    isPublicShared,
  }
}

export async function scanRelationshipQr(params: {
  workspaceId: string
  userId: string
  token: string
}) {
  const viewerWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  if (!viewerWorkspaceMember) {
    throw new Error("Workspace member not found")
  }

  const profile = await db
    .selectFrom("workspace_relationship_profiles as p")
    .innerJoin("access_subjects as s", "s.id", "p.subject_id")
    .select([
      "p.id",
      "p.workspace_id",
      "p.subject_id",
      "p.identity_id",
      "p.identity_search_enabled",
      "p.approval_mode",
      "p.qr_token",
      "p.created_by_workspace_member_id",
      "p.created_at",
      "p.updated_at",
      "s.kind as subject_type",
      "s.workspace_member_id as subject_workspace_member_id",
      "s.actor_id as subject_actor_id",
      "s.remote_agent_id as subject_remote_agent_id",
    ])
    .where("p.qr_token", "=", params.token)
    .executeTakeFirst()
  if (!profile) {
    throw new Error("Relationship QR code not found")
  }

  if (profile.subject_type === "workspace_member") {
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
    })
  }

  return requestRelationshipByIdentityProfile({
    workspaceId: params.workspaceId,
    userId: params.userId,
    profileId: profile.id,
    requireSearchable: false,
  })
}

export async function listFriends(params: {
  workspaceId: string
  userId: string
}) {
  const entries = (await buildContactHubEntryMap(params)).friends
  return { friends: entries }
}

export async function listFriendRequests(params: {
  workspaceId: string
  userId: string
}) {
  const viewerWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  if (!viewerWorkspaceMember) {
    throw new Error("Workspace member not found")
  }

  const pendingRows = await db
    .selectFrom("workspace_friend_requests as r")
    .innerJoin("access_subjects as s", "s.id", "r.target_subject_id")
    .select([
      "r.id",
      "r.requester_workspace_member_id",
      "r.target_subject_id",
      "r.requested_via_profile_id",
      "r.status",
      "r.resolved_by_workspace_member_id",
      "r.resolved_at",
      "r.created_at",
      "r.updated_at",
      "s.kind as target_kind",
      "s.workspace_member_id as target_workspace_member_id",
      "s.actor_id as target_actor_id",
      "s.remote_agent_id as target_remote_agent_id",
    ])
    .where("r.status", "=", "pending")
    .orderBy("r.created_at", "desc")
    .execute()
  const outgoingRows = pendingRows.filter(
    (row) =>
      row.requester_workspace_member_id ===
      viewerWorkspaceMember.workspaceMemberId
  )

  const incoming = []
  for (const row of pendingRows) {
    if (row.target_kind === "workspace_member") {
      if (
        row.target_workspace_member_id !==
        viewerWorkspaceMember.workspaceMemberId
      ) {
        continue
      }
    } else if (row.target_kind === "actor" && row.target_actor_id) {
      const targetActor = await getActorSummary(row.target_actor_id)
      if (!targetActor || targetActor.workspace.id !== params.workspaceId) {
        continue
      }
      const canApprove = await authorizeAction(db, {
        subject: await resolveWorkspaceAccessSubject(
          db,
          params.workspaceId,
          params.userId
        ),
        action: "actor.grant",
        resourceId: row.target_actor_id,
      })
      if (!canApprove) continue
    } else if (
      row.target_kind === "remote_agent" &&
      row.target_remote_agent_id
    ) {
      const targetRemoteAgent = await getRemoteAgentSummary(
        row.target_remote_agent_id
      )
      if (
        !targetRemoteAgent ||
        targetRemoteAgent.workspace.id !== params.workspaceId
      ) {
        continue
      }
      const canApprove = await authorizeAction(db, {
        subject: await resolveWorkspaceAccessSubject(
          db,
          params.workspaceId,
          params.userId
        ),
        action: "remote_agent.grant",
        resourceId: row.target_remote_agent_id,
      })
      if (!canApprove) continue
    }

    const requester = await getWorkspaceMemberSummaryById(
      row.requester_workspace_member_id
    )
    const targetMember =
      row.target_kind === "workspace_member" && row.target_workspace_member_id
        ? await getWorkspaceMemberSummaryById(row.target_workspace_member_id)
        : null
    const targetActor =
      row.target_kind === "actor" && row.target_actor_id
        ? await getActorSummary(row.target_actor_id)
        : null
    const targetRemoteAgent =
      row.target_kind === "remote_agent" && row.target_remote_agent_id
        ? await getRemoteAgentSummary(row.target_remote_agent_id)
        : null
    incoming.push({
      id: row.id,
      status: row.status,
      createdAt: toIsoString(row.created_at),
      requester,
      targetType: subjectKindToRelationshipPeerType(row.target_kind),
      targetMember,
      targetActor,
      targetRemoteAgent,
    })
  }

  const outgoing = []
  for (const row of outgoingRows) {
    const targetMember =
      row.target_kind === "workspace_member" && row.target_workspace_member_id
        ? await getWorkspaceMemberSummaryById(row.target_workspace_member_id)
        : null
    const targetActor =
      row.target_kind === "actor" && row.target_actor_id
        ? await getActorSummary(row.target_actor_id)
        : null
    const targetRemoteAgent =
      row.target_kind === "remote_agent" && row.target_remote_agent_id
        ? await getRemoteAgentSummary(row.target_remote_agent_id)
        : null
    outgoing.push({
      id: row.id,
      status: row.status,
      createdAt: toIsoString(row.created_at),
      targetType: subjectKindToRelationshipPeerType(row.target_kind),
      targetMember,
      targetActor,
      targetRemoteAgent,
    })
  }

  return { incoming, outgoing }
}

export async function resolveFriendRequest(params: {
  workspaceId: string
  userId: string
  requestId: string
  decision: "approve" | "reject"
}) {
  const viewerWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  if (!viewerWorkspaceMember) {
    throw new Error("Workspace member not found")
  }
  const request = await db
    .selectFrom("workspace_friend_requests as r")
    .innerJoin("access_subjects as s", "s.id", "r.target_subject_id")
    .select([
      "r.id",
      "r.requester_workspace_member_id",
      "r.target_subject_id",
      "r.requested_via_profile_id",
      "r.status",
      "r.resolved_by_workspace_member_id",
      "r.resolved_at",
      "r.created_at",
      "r.updated_at",
      "s.kind as target_subject_type",
      "s.workspace_member_id as target_workspace_member_id",
      "s.actor_id as target_actor_id",
      "s.remote_agent_id as target_remote_agent_id",
    ])
    .where("r.id", "=", params.requestId)
    .executeTakeFirst()
  if (!request) {
    throw new Error("Friend request not found")
  }
  if (request.status !== "pending") {
    throw new Error("Friend request has already been resolved")
  }

  if (request.target_subject_type === "workspace_member") {
    if (
      request.target_workspace_member_id !==
      viewerWorkspaceMember.workspaceMemberId
    ) {
      throw new Error("Not allowed to resolve this friend request")
    }
  } else if (
    request.target_subject_type === "actor" &&
    request.target_actor_id
  ) {
    const targetActor = await getActorSummary(request.target_actor_id)
    if (!targetActor || targetActor.workspace.id !== params.workspaceId) {
      throw new Error("Friend request not found")
    }
    const canApprove = await authorizeAction(db, {
      subject: await resolveWorkspaceAccessSubject(
        db,
        params.workspaceId,
        params.userId
      ),
      action: "actor.grant",
      resourceId: request.target_actor_id,
    })
    if (!canApprove) {
      throw new Error("Not allowed to resolve this friend request")
    }
  } else if (
    request.target_subject_type === "remote_agent" &&
    request.target_remote_agent_id
  ) {
    const targetRemoteAgent = await getRemoteAgentSummary(
      request.target_remote_agent_id
    )
    if (
      !targetRemoteAgent ||
      targetRemoteAgent.workspace.id !== params.workspaceId
    ) {
      throw new Error("Friend request not found")
    }
    const canApprove = await authorizeAction(db, {
      subject: await resolveWorkspaceAccessSubject(
        db,
        params.workspaceId,
        params.userId
      ),
      action: "remote_agent.grant",
      resourceId: request.target_remote_agent_id,
    })
    if (!canApprove) {
      throw new Error("Not allowed to resolve this friend request")
    }
  }

  if (params.decision === "approve") {
    await createOrApproveFriendship({
      requesterWorkspaceMemberId: request.requester_workspace_member_id,
      targetType: subjectKindToRelationshipPeerType(
        request.target_subject_type
      ),
      targetWorkspaceMemberId: request.target_workspace_member_id || undefined,
      targetActorId: request.target_actor_id || undefined,
      targetRemoteAgentId: request.target_remote_agent_id || undefined,
      sourceRequestId: request.id,
    })
  }

  const updated = await db
    .updateTable("workspace_friend_requests")
    .set({
      status: params.decision === "approve" ? "approved" : "rejected",
      resolved_by_workspace_member_id: viewerWorkspaceMember.workspaceMemberId,
      resolved_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })
    .where("id", "=", request.id)
    .returningAll()
    .executeTakeFirst()

  if (!updated) {
    throw new Error("Failed to resolve friend request")
  }

  return updated
}

export async function listActorAccessRequests(params: {
  workspaceId: string
  userId: string
}) {
  const viewerWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  if (!viewerWorkspaceMember) {
    throw new Error("Workspace member not found")
  }
  // P2/P1b: SELECT from the merged entity_access_requests, filter on the joined
  // access_subjects kind='actor', and project the actor_id from the subject.
  const [incomingRows, outgoingRows] = await Promise.all([
    db
      .selectFrom("entity_access_requests as ear")
      .innerJoin("access_subjects as subj", "subj.id", "ear.target_subject_id")
      .select([
        "ear.id",
        "ear.workspace_id",
        "ear.requester_workspace_member_id",
        "ear.status",
        "ear.resolved_by_workspace_member_id",
        "ear.resolved_at",
        "ear.created_at",
        "ear.updated_at",
        "subj.actor_id as actor_id",
      ])
      .where("ear.workspace_id", "=", params.workspaceId)
      .where("ear.status", "=", "pending")
      .where("subj.kind", "=", "actor")
      .execute(),
    db
      .selectFrom("entity_access_requests as ear")
      .innerJoin("access_subjects as subj", "subj.id", "ear.target_subject_id")
      .select([
        "ear.id",
        "ear.workspace_id",
        "ear.requester_workspace_member_id",
        "ear.status",
        "ear.resolved_by_workspace_member_id",
        "ear.resolved_at",
        "ear.created_at",
        "ear.updated_at",
        "subj.actor_id as actor_id",
      ])
      .where("ear.workspace_id", "=", params.workspaceId)
      .where(
        "ear.requester_workspace_member_id",
        "=",
        viewerWorkspaceMember.workspaceMemberId
      )
      .where("ear.status", "=", "pending")
      .where("subj.kind", "=", "actor")
      .execute(),
  ])

  const incoming = []
  for (const row of incomingRows) {
    if (!row.actor_id) continue
    const canApprove = await authorizeAction(db, {
      subject: await resolveWorkspaceAccessSubject(
        db,
        params.workspaceId,
        params.userId
      ),
      action: "actor.grant",
      resourceId: row.actor_id,
    })
    if (!canApprove) continue
    incoming.push({
      id: row.id,
      status: row.status,
      createdAt: toIsoString(row.created_at),
      requester: await getWorkspaceMemberSummaryById(
        row.requester_workspace_member_id
      ),
      actor: await getActorSummary(row.actor_id),
    })
  }

  const outgoing = []
  for (const row of outgoingRows) {
    if (!row.actor_id) continue
    outgoing.push({
      id: row.id,
      status: row.status,
      createdAt: toIsoString(row.created_at),
      actor: await getActorSummary(row.actor_id),
    })
  }

  return { incoming, outgoing }
}

export async function listRemoteAgentAccessRequests(params: {
  workspaceId: string
  userId: string
}) {
  const viewerWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  if (!viewerWorkspaceMember) {
    throw new Error("Workspace member not found")
  }

  const [incomingRows, outgoingRows] = await Promise.all([
    executeSql<any>(
      `
        SELECT ear.id, ear.workspace_id, ear.requester_workspace_member_id,
               ear.status, ear.resolved_by_workspace_member_id, ear.resolved_at,
               ear.created_at, ear.updated_at,
               subj.remote_agent_id AS remote_agent_id
        FROM entity_access_requests ear
        JOIN access_subjects subj ON subj.id = ear.target_subject_id
        WHERE ear.workspace_id = $1
          AND ear.status = 'pending'
          AND subj.kind = 'remote_agent'
        ORDER BY ear.created_at DESC
      `,
      [params.workspaceId]
    ).then((result) => result.rows),
    executeSql<any>(
      `
        SELECT ear.id, ear.workspace_id, ear.requester_workspace_member_id,
               ear.status, ear.resolved_by_workspace_member_id, ear.resolved_at,
               ear.created_at, ear.updated_at,
               subj.remote_agent_id AS remote_agent_id
        FROM entity_access_requests ear
        JOIN access_subjects subj ON subj.id = ear.target_subject_id
        WHERE ear.workspace_id = $1
          AND ear.requester_workspace_member_id = $2
          AND ear.status = 'pending'
          AND subj.kind = 'remote_agent'
        ORDER BY ear.created_at DESC
      `,
      [params.workspaceId, viewerWorkspaceMember.workspaceMemberId]
    ).then((result) => result.rows),
  ])

  const incoming = []
  for (const row of incomingRows) {
    const canApprove = await authorizeAction(db, {
      subject: await resolveWorkspaceAccessSubject(
        db,
        params.workspaceId,
        params.userId
      ),
      action: "remote_agent.grant",
      resourceId: row.remote_agent_id,
    })
    if (!canApprove) continue
    incoming.push({
      id: row.id,
      status: row.status,
      createdAt: toIsoString(row.created_at),
      requester: await getWorkspaceMemberSummaryById(
        row.requester_workspace_member_id
      ),
      remoteAgent: await getRemoteAgentSummary(row.remote_agent_id),
    })
  }

  const outgoing = []
  for (const row of outgoingRows) {
    outgoing.push({
      id: row.id,
      status: row.status,
      createdAt: toIsoString(row.created_at),
      remoteAgent: await getRemoteAgentSummary(row.remote_agent_id),
    })
  }

  return { incoming, outgoing }
}

export async function resolveActorAccessRequest(params: {
  workspaceId: string
  userId: string
  requestId: string
  decision: "approve" | "reject"
}) {
  const approverWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  if (!approverWorkspaceMember) {
    throw new Error("Workspace member not found")
  }
  const request = await db
    .selectFrom("entity_access_requests as ear")
    .innerJoin("access_subjects as subj", "subj.id", "ear.target_subject_id")
    .select([
      "ear.id",
      "ear.workspace_id",
      "ear.requester_workspace_member_id",
      "ear.status",
      "subj.actor_id as actor_id",
      "subj.kind as target_kind",
    ])
    .where("ear.id", "=", params.requestId)
    .executeTakeFirst()
  if (
    !request ||
    request.workspace_id !== params.workspaceId ||
    request.target_kind !== "actor" ||
    !request.actor_id
  ) {
    throw new Error("Actor access request not found")
  }
  if (request.status !== "pending") {
    throw new Error("Actor access request has already been resolved")
  }
  const canApprove = await authorizeAction(db, {
    subject: await resolveWorkspaceAccessSubject(
      db,
      params.workspaceId,
      params.userId
    ),
    action: "actor.grant",
    resourceId: request.actor_id,
  })
  if (!canApprove) {
    throw new Error("Not allowed to resolve this actor access request")
  }

  if (params.decision === "approve") {
    await grantActorAccess({
      workspaceId: params.workspaceId,
      actorId: request.actor_id,
      requesterWorkspaceMemberId: request.requester_workspace_member_id,
      grantedByWorkspaceMemberId: approverWorkspaceMember.workspaceMemberId,
    })
  }

  const updated = await db
    .updateTable("entity_access_requests")
    .set({
      status: params.decision === "approve" ? "approved" : "rejected",
      resolved_by_workspace_member_id:
        approverWorkspaceMember.workspaceMemberId,
      resolved_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })
    .where("id", "=", request.id)
    .returningAll()
    .executeTakeFirst()
  if (!updated) {
    throw new Error("Failed to resolve actor access request")
  }
  return updated
}

export async function resolveRemoteAgentAccessRequest(params: {
  workspaceId: string
  userId: string
  requestId: string
  decision: "approve" | "reject"
}) {
  const approverWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  if (!approverWorkspaceMember) {
    throw new Error("Workspace member not found")
  }

  const requestResult = await executeSql<any>(
    `
      SELECT ear.id, ear.workspace_id, ear.requester_workspace_member_id,
             ear.status, ear.resolved_at, ear.resolved_by_workspace_member_id,
             subj.remote_agent_id AS remote_agent_id, subj.kind AS target_kind
      FROM entity_access_requests ear
      JOIN access_subjects subj ON subj.id = ear.target_subject_id
      WHERE ear.id = $1
      LIMIT 1
    `,
    [params.requestId]
  )
  const request = requestResult.rows[0]
  if (
    !request ||
    request.workspace_id !== params.workspaceId ||
    request.target_kind !== "remote_agent" ||
    !request.remote_agent_id
  ) {
    throw new Error("Remote agent access request not found")
  }
  if (request.status !== "pending") {
    throw new Error("Remote agent access request has already been resolved")
  }

  const canApprove = await authorizeAction(db, {
    subject: await resolveWorkspaceAccessSubject(
      db,
      params.workspaceId,
      params.userId
    ),
    action: "remote_agent.grant",
    resourceId: request.remote_agent_id,
  })
  if (!canApprove) {
    throw new Error("Not allowed to resolve this remote agent access request")
  }

  if (params.decision === "approve") {
    await grantRemoteAgentAccess({
      workspaceId: params.workspaceId,
      remoteAgentId: request.remote_agent_id,
      requesterWorkspaceMemberId: request.requester_workspace_member_id,
    })
  }

  const updated = await executeSql<any>(
    `
      UPDATE entity_access_requests
      SET status = $2,
          resolved_by_workspace_member_id = $3,
          resolved_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [
      request.id,
      params.decision === "approve" ? "approved" : "rejected",
      approverWorkspaceMember.workspaceMemberId,
    ]
  )
  if (!updated.rows[0]) {
    throw new Error("Failed to resolve remote agent access request")
  }
  return updated.rows[0]
}

export async function getContactHub(params: {
  workspaceId: string
  userId: string
}): Promise<ContactHubResponse> {
  const viewerWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  if (!viewerWorkspaceMember) {
    throw new Error("Workspace member not found")
  }
  const [
    { incoming: friendIncoming },
    { incoming: actorIncoming },
    { incoming: remoteAgentIncoming },
    entries,
  ] = await Promise.all([
    listFriendRequests(params),
    listActorAccessRequests(params),
    listRemoteAgentAccessRequests(params),
    buildContactHubEntryMap(params),
  ])
  const threads = await listWorkspaceConversationViews({
    workspaceId: params.workspaceId,
    workspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
  })
  const groups = await Promise.all(
    threads
      .filter((thread) => thread.kind === CONVERSATION_KIND.GROUP)
      .map((thread) =>
        mapConversationSummaryView(
          {
            id: thread.conversationId,
            kind: thread.kind,
            is_im: thread.isIm,
            title: thread.title,
            unread_count: thread.unreadCount,
            created_at: thread.createdAt,
            transport_kind: undefined,
          },
          {
            workspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
          }
        )
      )
  )

  return {
    requestSummary: {
      friendPendingCount: friendIncoming.length,
      actorAccessPendingCount: actorIncoming.length,
      remoteAgentAccessPendingCount: remoteAgentIncoming.length,
      totalPendingCount:
        friendIncoming.length +
        actorIncoming.length +
        remoteAgentIncoming.length,
    },
    workspaceActors: entries.workspaceActors,
    workspaceRemoteAgents: entries.workspaceRemoteAgents,
    workspaceMembers: entries.workspaceMembers,
    friends: entries.friends,
    groups,
  }
}

export async function getContactHubDetail(params: {
  workspaceId: string
  userId: string
  contactKind: ContactHubKind
  contactId: string
}): Promise<ContactHubDetailResponse> {
  const hub = await getContactHub({
    workspaceId: params.workspaceId,
    userId: params.userId,
  })
  const entry = [
    ...hub.workspaceActors,
    ...((hub as any).workspaceRemoteAgents ?? []),
    ...hub.workspaceMembers,
    ...hub.friends,
  ].find(
    (item) => item.kind === params.contactKind && item.id === params.contactId
  )
  if (!entry) {
    throw new Error("Contact not found")
  }

  const relatedGroups = hub.groups.filter((conversation) => {
    if (entry.actorId) {
      return conversation.participants.some(
        (participant) =>
          participant.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR &&
          participant.actorId === entry.actorId
      )
    }
    if (entry.remoteAgentId) {
      return conversation.participants.some(
        (participant) =>
          participant.participantType ===
            CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT &&
          participant.remoteAgentId === entry.remoteAgentId
      )
    }
    if (entry.workspaceMemberId) {
      return conversation.participants.some(
        (participant) =>
          participant.participantType ===
            CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER &&
          participant.workspaceMemberId === entry.workspaceMemberId
      )
    }
    return false
  })

  return {
    contact: entry,
    groups: relatedGroups,
  }
}

export async function openDirectConversation(params: {
  workspaceId: string
  userId: string
  contactKind: ContactHubKind
  contactId: string
}): Promise<DirectConversationOpenResponse> {
  const resolved = await resolveContactReference(params)
  const requesterWorkspaceMember = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  if (!requesterWorkspaceMember) {
    throw new Error("Workspace member not found")
  }
  const requesterIdentity: DirectConversationIdentity = {
    kind: RELATIONSHIP_PROFILE_SUBJECT_TYPE.MEMBER,
    workspaceMemberId: requesterWorkspaceMember.workspaceMemberId,
  }

  if (resolved.kind === CONTACT_HUB_KIND.WORKSPACE_ACTOR && resolved.actor) {
    const canInvoke = await authorizeAction(db, {
      subject: await resolveWorkspaceAccessSubject(
        db,
        params.workspaceId,
        params.userId
      ),
      action: "actor.invoke",
      resourceId: resolved.actor.actorId,
    })

    if (
      !canInvoke &&
      resolved.actor.accessPolicy ===
        RELATIONSHIP_ACCESS_POLICY.APPROVAL_REQUIRED
    ) {
      const profile = await ensureRelationshipProfile({
        workspaceId: params.workspaceId,
        createdByWorkspaceMemberId: requesterWorkspaceMember.workspaceMemberId,
        subjectType: RELATIONSHIP_PROFILE_SUBJECT_TYPE.ACTOR,
        subjectActorId: resolved.actor.actorId,
      })
      if (profile.approval_mode === RELATIONSHIP_APPROVAL_MODE.AUTO) {
        await grantActorAccess({
          workspaceId: params.workspaceId,
          actorId: resolved.actor.actorId,
          requesterWorkspaceMemberId:
            requesterWorkspaceMember.workspaceMemberId,
          grantedByWorkspaceMemberId:
            requesterWorkspaceMember.workspaceMemberId,
        })
      } else {
        const accessRequest = await createActorAccessRequest({
          workspaceId: params.workspaceId,
          actorId: resolved.actor.actorId,
          requesterWorkspaceMemberId:
            requesterWorkspaceMember.workspaceMemberId,
        })
        return {
          status: DIRECT_CONVERSATION_OPEN_STATUS.PENDING_APPROVAL,
          requestId: accessRequest.request.id,
        }
      }
    }
  }

  if (
    resolved.kind === CONTACT_HUB_KIND.WORKSPACE_REMOTE_AGENT &&
    resolved.remoteAgent
  ) {
    // A direct conversation is a native (non-IM, workspace-scoped) conversation
    // (kind=direct, no transport binding), so its participants must all belong
    // to the
    // requester's workspace. A friend remote agent from another workspace
    // (public-shared discovery makes this reachable) cannot be opened as a
    // direct chat — reject explicitly here rather than letting it surface as a
    // generic invalid_remote_agent / participant-trigger error downstream.
    if (resolved.remoteAgent.workspace.id !== params.workspaceId) {
      throw new Error(
        "Cannot open a direct conversation with a remote agent from another workspace"
      )
    }
    const canInvoke = await authorizeAction(db, {
      subject: await resolveWorkspaceAccessSubject(
        db,
        params.workspaceId,
        params.userId
      ),
      action: "remote_agent.invoke",
      resourceId: resolved.remoteAgent.remoteAgentId,
    })

    if (
      !canInvoke &&
      resolved.remoteAgent.accessPolicy ===
        RELATIONSHIP_ACCESS_POLICY.APPROVAL_REQUIRED
    ) {
      const profile = await ensureRelationshipProfile({
        workspaceId: params.workspaceId,
        createdByWorkspaceMemberId: requesterWorkspaceMember.workspaceMemberId,
        subjectType: RELATIONSHIP_PROFILE_SUBJECT_TYPE.REMOTE_AGENT,
        subjectRemoteAgentId: resolved.remoteAgent.remoteAgentId,
      })
      if (profile.approval_mode === RELATIONSHIP_APPROVAL_MODE.AUTO) {
        await grantRemoteAgentAccess({
          workspaceId: params.workspaceId,
          remoteAgentId: resolved.remoteAgent.remoteAgentId,
          requesterWorkspaceMemberId:
            requesterWorkspaceMember.workspaceMemberId,
        })
      } else {
        const accessRequest = await createRemoteAgentAccessRequest({
          workspaceId: params.workspaceId,
          remoteAgentId: resolved.remoteAgent.remoteAgentId,
          requesterWorkspaceMemberId:
            requesterWorkspaceMember.workspaceMemberId,
        })
        return {
          status: DIRECT_CONVERSATION_OPEN_STATUS.PENDING_APPROVAL,
          requestId: accessRequest.request.id,
        }
      }
    }
  }

  const existingConversationId = await findDirectConversationId(
    requesterIdentity,
    resolved.peerIdentity
  )
  if (existingConversationId) {
    return {
      status: DIRECT_CONVERSATION_OPEN_STATUS.READY,
      created: false,
      conversationId: existingConversationId,
    }
  }

  try {
    const targetWorkspaceMemberId =
      resolved.peerIdentity.kind === RELATIONSHIP_PROFILE_SUBJECT_TYPE.MEMBER
        ? resolved.member?.workspaceMemberId
        : undefined
    if (
      resolved.peerIdentity.kind === RELATIONSHIP_PROFILE_SUBJECT_TYPE.MEMBER &&
      !targetWorkspaceMemberId
    ) {
      throw new Error("Peer workspace membership not found")
    }
    const created = await createChatConversation({
      workspaceId: params.workspaceId,
      userId: params.userId,
      clientRequestId: uuidv4(),
      kind: CONVERSATION_KIND.DIRECT,
      actorIds:
        resolved.peerIdentity.kind === RELATIONSHIP_PROFILE_SUBJECT_TYPE.ACTOR
          ? [resolved.peerIdentity.actorId]
          : [],
      remoteAgentIds:
        resolved.peerIdentity.kind ===
        RELATIONSHIP_PROFILE_SUBJECT_TYPE.REMOTE_AGENT
          ? [resolved.peerIdentity.remoteAgentId]
          : [],
      workspaceMemberIds: targetWorkspaceMemberId
        ? [targetWorkspaceMemberId]
        : [],
    })

    const directBindingValues = await directConversationBindingValues(
      db,
      canonicalizeDirectConversationPair(
        requesterIdentity,
        resolved.peerIdentity
      )
    )
    await db
      .insertInto("direct_conversation_bindings")
      .values({
        conversation_id: created.conversation.conversationId,
        ...directBindingValues,
      })
      .execute()

    return {
      status: DIRECT_CONVERSATION_OPEN_STATUS.READY,
      created: true,
      conversationId: created.conversation.conversationId as string,
    }
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error
    }
    const retryConversationId = await findDirectConversationId(
      requesterIdentity,
      resolved.peerIdentity
    )
    if (!retryConversationId) throw error
    return {
      status: DIRECT_CONVERSATION_OPEN_STATUS.READY,
      created: false,
      conversationId: retryConversationId,
    }
  }
}
