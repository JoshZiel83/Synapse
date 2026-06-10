import { sql } from "kysely"
import { v4 as uuidv4 } from "uuid"
import { serializeOptionalInstant } from "../../infrastructure/datetime.js"
import {
  CONTACT_DIRECT_STATE,
  CONTACT_HUB_KIND,
  CONVERSATION_KIND,
  CONVERSATION_PARTICIPANT_TYPE,
  CONTACT_TARGET_TYPE,
  DIRECT_CONVERSATION_OPEN_STATUS,
  IDENTITY_SEARCH_MATCH_STATE,
  IDENTITY_SEARCH_OUTCOME,
  RELATIONSHIP_APPROVAL_MODE,
  RELATIONSHIP_PROFILE_SUBJECT_TYPE,
  RELATIONSHIP_SCAN_OUTCOME,
  WORKSPACE_APP_KIND,
  WORKSPACE_APP_GRANT_PERMISSION,
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
  type RelationshipActorSummaryView,
  type RelationshipApprovalMode,
  type RelationshipMemberSummaryView,
  type RelationshipProfileView,
  type RelationshipRemoteAgentSummaryView,
  type RelationshipScanResponse,
  type RemoteAgentAccessRequestListResponse,
} from "@synapse/shared"
import { db } from "../../infrastructure/database/kysely.js"
import { getFileUrlById } from "../files/service.js"
import {
  authorizeAction,
  resolveWorkspaceAccessSubject,
  userSubject,
  workspaceMemberSubject,
} from "../access/service.js"
import {
  deriveRequiresContactApproval,
  deriveRequiresContactApprovalMany,
} from "../access/contact-approval.js"
import {
  insertWorkspaceAppGrant,
  insertWorkspaceAppGrantRequest,
  resolveWorkspaceAppGrantRequest,
} from "../workspace-apps/grant-storage.js"
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

type WorkspaceAppGrantRequestJoinRow = {
  id: string
  workspaceId: string
  requesterWorkspaceMemberId: string
  status: string
  resolvedByWorkspaceMemberId: string | null
  resolvedAt: Date | null
  createdAt: Date
  updatedAt: Date
  remoteAgentId: string | null
}

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
  workspaceId?: string
  workspaceName?: string
  workspaceSlug?: string
  id?: string
  name?: string
  slug?: string
}) {
  return {
    id: row.workspaceId || row.id || "",
    name: row.workspaceName || row.name || "Unknown workspace",
    slug: row.workspaceSlug || row.slug || "",
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
    .selectFrom("workspaceMembers as wm")
    .innerJoin("users as u", "u.id", "wm.userId")
    .innerJoin("workspaces as w", "w.id", "wm.workspaceId")
    .select([
      "wm.id as workspaceMemberId",
      "wm.workspaceId",
      "w.name as workspaceName",
      "w.slug as workspaceSlug",
      "wm.userId",
      "wm.trustLevel",
      "u.name",
      "u.email",
      "u.avatarFileId",
    ])
    .where("wm.workspaceId", "=", workspaceId)
    .where("wm.userId", "=", userId)
    .executeTakeFirst()
  if (!row) return null
  return {
    workspace: workspaceSummary(row),
    workspaceMemberId: row.workspaceMemberId,
    userId: row.userId,
    trustLevel: row.trustLevel,
    name: row.name,
    email: row.email,
    avatarFileId: row.avatarFileId,
  }
}

async function getWorkspaceMemberSummaryById(
  workspaceMemberId: string
): Promise<WorkspaceMemberSummary | null> {
  const row = await db
    .selectFrom("workspaceMembers as wm")
    .innerJoin("users as u", "u.id", "wm.userId")
    .innerJoin("workspaces as w", "w.id", "wm.workspaceId")
    .select([
      "wm.id as workspaceMemberId",
      "wm.workspaceId",
      "w.name as workspaceName",
      "w.slug as workspaceSlug",
      "wm.userId",
      "wm.trustLevel",
      "u.name",
      "u.email",
      "u.avatarFileId",
    ])
    .where("wm.id", "=", workspaceMemberId)
    .executeTakeFirst()
  if (!row) return null
  return {
    workspace: workspaceSummary(row),
    workspaceMemberId: row.workspaceMemberId,
    userId: row.userId,
    trustLevel: row.trustLevel,
    name: row.name,
    email: row.email,
    avatarFileId: row.avatarFileId,
  }
}

async function getMemberRelationshipProfileRow(workspaceMemberId: string) {
  const subjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    memberId: workspaceMemberId,
  })
  const row = await db
    .selectFrom("workspaceRelationshipProfiles")
    .select([
      "id",
      "workspaceId",
      "identityId",
      "identitySearchEnabled",
      "approvalMode",
      "qrToken",
    ])
    .where("subjectId", "=", subjectId)
    .executeTakeFirst()
  if (!row) {
    throw new Error("Relationship profile not found")
  }
  return row
}

async function getActorSummary(actorId: string): Promise<ActorSummary | null> {
  const row = await db
    .selectFrom("actors as a")
    .innerJoin("workspaceApps as app", "app.id", "a.id")
    .innerJoin("workspaces as w", "w.id", "app.workspaceId")
    .leftJoin("fileAssets as avatar_file", "avatar_file.id", "a.avatarFileId")
    .select([
      "a.id as actorId",
      "app.workspaceId",
      "w.name as workspaceName",
      "w.slug as workspaceSlug",
      "app.displayName",
      "a.title",
      "a.role",
      "a.isPublicShared",
      "a.avatarEmoji",
      "avatar_file.id as avatarFileId",
    ])
    .where("a.id", "=", actorId)
    .where("app.deletedAt", "is", null)
    .where("app.status", "=", "active")
    .executeTakeFirst()
  if (!row) return null
  const requiresContactApproval = await deriveRequiresContactApproval(
    db,
    "actor",
    row.actorId,
    row.workspaceId
  )
  return {
    workspace: workspaceSummary(row),
    actorId: row.actorId,
    displayName: row.displayName,
    title: row.title,
    role: row.role,
    avatarFileId: row.avatarFileId,
    avatarEmoji: row.avatarEmoji,
    requiresContactApproval,
    isPublicShared: Boolean(row.isPublicShared),
  }
}

async function getRemoteAgentSummary(
  remoteAgentId: string
): Promise<RemoteAgentSummary | null> {
  const result = await sql<{
    remoteAgentId: string
    workspaceId: string
    workspaceName: string
    workspaceSlug: string
    displayName: string
    title: string
    runtimeKind: "claude_code" | "codex"
    avatarFileId: string | null
    avatarEmoji: string | null
    isPublicShared: boolean
  }>`
      SELECT
        ra.id AS remote_agent_id,
        app.workspace_id,
        w.name AS workspace_name,
        w.slug AS workspace_slug,
        app.display_name,
        ra.title,
        ra.runtime_kind,
        ra.avatar_file_id,
        ra.avatar_emoji,
        ra.is_public_shared
      FROM remote_agents ra
      INNER JOIN workspace_apps_live app
        ON app.id = ra.id
      INNER JOIN workspaces w ON w.id = app.workspace_id
      WHERE ra.id = ${remoteAgentId}
        AND app.deleted_at IS NULL
        AND app.status = 'active'
      LIMIT 1
    `.execute(db)

  const row = result.rows[0]
  if (!row) return null
  const requiresContactApproval = await deriveRequiresContactApproval(
    db,
    "remote_agent",
    row.remoteAgentId,
    row.workspaceId
  )
  return {
    workspace: workspaceSummary(row),
    remoteAgentId: row.remoteAgentId,
    displayName: row.displayName,
    title: row.title,
    runtimeKind: row.runtimeKind,
    avatarFileId: row.avatarFileId,
    avatarEmoji: row.avatarEmoji,
    requiresContactApproval,
    isPublicShared: Boolean(row.isPublicShared),
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
    title: params.actor.displayName,
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
    title: params.remoteAgent.displayName,
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
    title: params.actor.displayName,
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
    title: params.remoteAgent.displayName,
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
    .selectFrom("workspaceRelationshipProfiles")
    .selectAll()
    .where("workspaceId", "=", params.workspaceId)
    .where("subjectId", "=", subjectId)
    .executeTakeFirst()
  if (existing) return existing

  const inserted = await db
    .insertInto("workspaceRelationshipProfiles")
    .values({
      workspaceId: params.workspaceId,
      subjectId: subjectId,
      qrToken: uuidv4(),
      createdByWorkspaceMemberId: params.createdByWorkspaceMemberId,
      approvalMode: "manual",
    })
    .returningAll()
    .executeTakeFirst()
  if (!inserted) {
    throw new Error("Failed to create relationship profile")
  }
  return inserted
}

async function grantActorContactVisibilityToMember(params: {
  workspaceId: string
  actorId: string
  requesterWorkspaceMemberId: string
  grantedByWorkspaceMemberId: string
}) {
  try {
    await insertWorkspaceAppGrant(db, {
      workspaceId: params.workspaceId,
      workspaceAppId: params.actorId,
      target: {
        subject: {
          kind: SUBJECT_KIND.WORKSPACE_MEMBER,
          memberId: params.requesterWorkspaceMemberId,
        },
      },
      permissions: [WORKSPACE_APP_GRANT_PERMISSION.CONTACT_VISIBLE],
      source: "approval",
      createdByWorkspaceMemberId: params.grantedByWorkspaceMemberId,
    })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
  }
}

async function grantRemoteAgentContactVisibilityToMember(params: {
  workspaceId: string
  remoteAgentId: string
  requesterWorkspaceMemberId: string
  grantedByWorkspaceMemberId?: string
}) {
  try {
    await insertWorkspaceAppGrant(db, {
      workspaceId: params.workspaceId,
      workspaceAppId: params.remoteAgentId,
      target: {
        subject: {
          kind: SUBJECT_KIND.WORKSPACE_MEMBER,
          memberId: params.requesterWorkspaceMemberId,
        },
      },
      permissions: [WORKSPACE_APP_GRANT_PERMISSION.CONTACT_VISIBLE],
      source: "approval",
      createdByWorkspaceMemberId: params.grantedByWorkspaceMemberId ?? null,
    })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
  }
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
    .insertInto("workspaceFriendEntries")
    .values({
      workspaceId: params.workspaceId,
      ownerWorkspaceMemberId: params.ownerWorkspaceMemberId,
      peerSubjectId: peerSubjectId,
      sourceRequestId: params.sourceRequestId || null,
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
    .selectFrom("workspaceFriendEntries as e")
    .innerJoin("accessSubjects as s", "s.id", "e.peerSubjectId")
    .select([
      "e.id",
      "e.workspaceId",
      "e.ownerWorkspaceMemberId",
      "e.peerSubjectId",
      "e.sourceRequestId",
      "e.createdAt",
      "e.updatedAt",
      "s.workspaceMemberId as peerWorkspaceMemberId",
      "s.actorId as peerActorId",
      "s.remoteAgentId as peerRemoteAgentId",
      "s.kind as peerKind",
    ])
    .where("e.workspaceId", "=", params.workspaceId)
    .where("e.ownerWorkspaceMemberId", "=", params.ownerWorkspaceMemberId)
    .where("e.peerSubjectId", "=", peerSubjectId)
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
    .selectFrom("workspaceFriendRequests as r")
    .innerJoin("accessSubjects as s", "s.id", "r.targetSubjectId")
    .select([
      "r.id",
      "r.requesterWorkspaceMemberId",
      "r.targetSubjectId",
      "r.requestedViaProfileId",
      "r.status",
      "r.resolvedByWorkspaceMemberId",
      "r.resolvedAt",
      "r.createdAt",
      "r.updatedAt",
      "s.kind as targetKind",
      "s.workspaceMemberId as targetWorkspaceMemberId",
      "s.actorId as targetActorId",
      "s.remoteAgentId as targetRemoteAgentId",
    ])
    .where(
      "r.requesterWorkspaceMemberId",
      "=",
      params.requesterWorkspaceMemberId
    )
    .where("r.targetSubjectId", "=", targetSubjectId)
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
      .insertInto("workspaceFriendRequests")
      .values({
        requesterWorkspaceMemberId: params.requesterWorkspaceMemberId,
        targetSubjectId: targetSubjectId,
        requestedViaProfileId: params.profileId || null,
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
  const existing = await db
    .selectFrom("workspaceAppGrantRequests as app_request")
    .selectAll()
    .where("workspaceId", "=", params.workspaceId)
    .where("workspaceAppId", "=", params.actorId)
    .where("requesterWorkspaceMemberId", "=", params.requesterWorkspaceMemberId)
    .where("status", "=", "pending")
    .executeTakeFirst()
  if (existing) {
    return {
      request: { ...existing, actor_id: params.actorId },
      created: false as const,
    }
  }

  try {
    const created = await insertWorkspaceAppGrantRequest(db, {
      workspaceId: params.workspaceId,
      workspaceAppId: params.actorId,
      grantee: {
        subject: {
          kind: SUBJECT_KIND.WORKSPACE_MEMBER,
          memberId: params.requesterWorkspaceMemberId,
        },
      },
      requestedPermissions: [WORKSPACE_APP_GRANT_PERMISSION.CONTACT_VISIBLE],
      requesterWorkspaceMemberId: params.requesterWorkspaceMemberId,
    })
    return {
      request: { ...created, actor_id: params.actorId },
      created: true as const,
    }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const retry = await db
      .selectFrom("workspaceAppGrantRequests")
      .selectAll()
      .where("workspaceId", "=", params.workspaceId)
      .where("workspaceAppId", "=", params.actorId)
      .where(
        "requesterWorkspaceMemberId",
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
  const existing = await db
    .selectFrom("workspaceAppGrantRequests")
    .selectAll()
    .where("workspaceId", "=", params.workspaceId)
    .where("workspaceAppId", "=", params.remoteAgentId)
    .where("requesterWorkspaceMemberId", "=", params.requesterWorkspaceMemberId)
    .where("status", "=", "pending")
    .executeTakeFirst()
  if (existing) {
    return {
      request: { ...existing, remote_agent_id: params.remoteAgentId },
      created: false as const,
    }
  }

  try {
    const created = await insertWorkspaceAppGrantRequest(db, {
      workspaceId: params.workspaceId,
      workspaceAppId: params.remoteAgentId,
      grantee: {
        subject: {
          kind: SUBJECT_KIND.WORKSPACE_MEMBER,
          memberId: params.requesterWorkspaceMemberId,
        },
      },
      requestedPermissions: [WORKSPACE_APP_GRANT_PERMISSION.CONTACT_VISIBLE],
      requesterWorkspaceMemberId: params.requesterWorkspaceMemberId,
    })
    return {
      request: { ...created, remote_agent_id: params.remoteAgentId },
      created: true as const,
    }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const retry = await db
      .selectFrom("workspaceAppGrantRequests")
      .selectAll()
      .where("workspaceId", "=", params.workspaceId)
      .where("workspaceAppId", "=", params.remoteAgentId)
      .where(
        "requesterWorkspaceMemberId",
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
    .selectFrom("directConversationBindings")
    .selectAll()
    .where((eb) =>
      eb.or([
        eb("participantOneSubjectId", "=", viewerSubjectId),
        eb("participantTwoSubjectId", "=", viewerSubjectId),
      ])
    )
    .execute()

  const viewerIdentity: DirectConversationIdentity = {
    kind: "workspace_member",
    workspaceMemberId,
  }
  const map = new Map<string, string>()
  for (const row of rows) {
    const peer = await directConversationBindingPeer(
      db,
      {
        participant_one_subject_id: row.participantOneSubjectId,
        participant_two_subject_id: row.participantTwoSubjectId,
      },
      viewerIdentity
    )
    if (!peer) continue
    map.set(directConversationIdentityKey(peer), row.conversationId)
  }
  return map
}

async function hasWorkspaceAppContactVisible(params: {
  workspaceId: string
  userId: string
  workspaceAppId: string
}): Promise<boolean> {
  const viewer = await getWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  if (!viewer) return false
  const app = await db
    .selectFrom("workspaceAppsLive")
    .select(["ownerWorkspaceMemberId", "kind"])
    .where("id", "=", params.workspaceAppId)
    .where("workspaceId", "=", params.workspaceId)
    .where("deletedAt", "is", null)
    .executeTakeFirst()
  if (!app) return false
  if (
    (app.kind === "actor" || app.kind === "remote_agent") &&
    app.ownerWorkspaceMemberId === viewer.workspaceMemberId
  ) {
    return true
  }
  const workspaceSubjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE,
    workspaceId: params.workspaceId,
  })
  const memberSubjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    memberId: viewer.workspaceMemberId,
  })
  const grant = await db
    .selectFrom("workspaceAppGrants")
    .select("id")
    .where("workspaceAppId", "=", params.workspaceAppId)
    .where("status", "=", "active")
    .where("scopeSubjectId", "is", null)
    .where(
      sql<boolean>`'contact_visible'::workspace_app_grant_permission = ANY(permissions)`
    )
    .where((eb) =>
      eb.or([
        eb("subjectId", "=", workspaceSubjectId),
        eb("subjectId", "=", memberSubjectId),
      ])
    )
    .limit(1)
    .executeTakeFirst()
  return Boolean(grant)
}

async function findDirectConversationId(
  left: DirectConversationIdentity,
  right: DirectConversationIdentity
) {
  const pair = canonicalizeDirectConversationPair(left, right)
  const values = await directConversationBindingValues(db, pair)
  const row = await db
    .selectFrom("directConversationBindings")
    .select(["conversationId"])
    .where("participantOneSubjectId", "=", values.participant_one_subject_id)
    .where("participantTwoSubjectId", "=", values.participant_two_subject_id)
    .executeTakeFirst()
  return row?.conversationId || null
}

async function getActorAccessState(params: {
  workspaceId: string
  userId: string
  actor: ActorSummary
  conversationId?: string
  pendingRequestActorIds: Set<string>
}) {
  if (params.conversationId) return CONTACT_DIRECT_STATE.EXISTING
  if (
    await hasWorkspaceAppContactVisible({
      workspaceId: params.workspaceId,
      userId: params.userId,
      workspaceAppId: params.actor.actorId,
    })
  ) {
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
  if (
    await hasWorkspaceAppContactVisible({
      workspaceId: params.workspaceId,
      userId: params.userId,
      workspaceAppId: params.remoteAgent.remoteAgentId,
    })
  ) {
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
    .selectFrom("workspaceFriendEntries as e")
    .innerJoin("accessSubjects as s", "s.id", "e.peerSubjectId")
    .select([
      "e.id",
      "e.workspaceId",
      "e.ownerWorkspaceMemberId",
      "e.peerSubjectId",
      "e.sourceRequestId",
      "e.createdAt",
      "e.updatedAt",
      "s.workspaceMemberId as peerWorkspaceMemberId",
      "s.actorId as peerActorId",
      "s.remoteAgentId as peerRemoteAgentId",
      "s.kind as peerKind",
    ])
    .where("e.workspaceId", "=", params.workspaceId)
    .where("e.ownerWorkspaceMemberId", "=", viewer?.workspaceMemberId || "")
    .where("e.id", "=", params.contactId)
    .executeTakeFirst()
  if (!friendEntry) {
    throw new Error("Friend not found")
  }

  if (params.contactKind === "friend-member") {
    if (!friendEntry.peerWorkspaceMemberId) {
      throw new Error("Friend not found")
    }
    const member = await getWorkspaceMemberSummaryById(
      friendEntry.peerWorkspaceMemberId
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
    if (!friendEntry.peerRemoteAgentId) {
      throw new Error("Friend not found")
    }
    const remoteAgent = await getRemoteAgentSummary(
      friendEntry.peerRemoteAgentId
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

  if (!friendEntry.peerActorId) {
    throw new Error("Friend not found")
  }
  const actor = await getActorSummary(friendEntry.peerActorId)
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
      .selectFrom("workspaceMembers as wm")
      .innerJoin("users as u", "u.id", "wm.userId")
      .innerJoin("workspaces as w", "w.id", "wm.workspaceId")
      .select([
        "wm.id as workspaceMemberId",
        "wm.workspaceId",
        "w.name as workspaceName",
        "w.slug as workspaceSlug",
        "wm.userId",
        "wm.trustLevel",
        "u.name",
        "u.email",
        "u.avatarFileId",
      ])
      .where("wm.workspaceId", "=", params.workspaceId)
      .where("wm.userId", "<>", params.userId)
      .orderBy("u.name", "asc")
      .execute(),
    db
      .selectFrom("actors as a")
      .innerJoin("workspaceApps as app", "app.id", "a.id")
      .innerJoin("workspaces as w", "w.id", "app.workspaceId")
      .leftJoin("fileAssets as avatar_file", "avatar_file.id", "a.avatarFileId")
      .select([
        "a.id as actorId",
        "app.workspaceId",
        "w.name as workspaceName",
        "w.slug as workspaceSlug",
        "app.displayName",
        "a.title",
        "a.role",
        "a.isPublicShared",
        "a.avatarEmoji",
        "avatar_file.id as avatarFileId",
      ])
      .where("app.workspaceId", "=", params.workspaceId)
      .where("app.deletedAt", "is", null)
      .where("app.status", "=", "active")
      .orderBy("app.displayName", "asc")
      .execute(),
    sql<{
      remoteAgentId: string
      workspaceId: string
      workspaceName: string
      workspaceSlug: string
      displayName: string
      title: string
      runtimeKind: "claude_code" | "codex"
      isPublicShared: boolean
      avatarEmoji: string | null
      avatarFileId: string | null
    }>`
          SELECT
            ra.id AS remote_agent_id,
            app.workspace_id,
            w.name AS workspace_name,
            w.slug AS workspace_slug,
            app.display_name,
            ra.title,
            ra.runtime_kind,
            ra.is_public_shared,
            ra.avatar_emoji,
            ra.avatar_file_id
          FROM remote_agents ra
          INNER JOIN workspace_apps_live app
            ON app.id = ra.id
          INNER JOIN workspaces w ON w.id = app.workspace_id
          WHERE app.workspace_id = ${params.workspaceId}
            AND app.deleted_at IS NULL
            AND app.status = 'active'
          ORDER BY app.display_name ASC, ra.created_at ASC
        `.execute(db),
    db
      .selectFrom("workspaceFriendEntries as e")
      .innerJoin("accessSubjects as s", "s.id", "e.peerSubjectId")
      .select([
        "e.id",
        "e.workspaceId",
        "e.ownerWorkspaceMemberId",
        "e.peerSubjectId",
        "e.sourceRequestId",
        "e.createdAt",
        "e.updatedAt",
        "s.workspaceMemberId as peerWorkspaceMemberId",
        "s.actorId as peerActorId",
        "s.remoteAgentId as peerRemoteAgentId",
        "s.kind as peerKind",
      ])
      .where("e.workspaceId", "=", params.workspaceId)
      .where(
        "e.ownerWorkspaceMemberId",
        "=",
        viewerWorkspaceMember?.workspaceMemberId || ""
      )
      .orderBy("e.createdAt", "desc")
      .execute(),
    viewerWorkspaceMember
      ? db
          .selectFrom("workspaceAppGrantRequests as app_request")
          .innerJoin(
            "workspaceApps as app",
            "app.id",
            "app_request.workspaceAppId"
          )
          .select(["app_request.workspaceAppId as actorId"])
          .where("app_request.workspaceId", "=", params.workspaceId)
          .where(
            "app_request.requesterWorkspaceMemberId",
            "=",
            viewerWorkspaceMember.workspaceMemberId
          )
          .where("app_request.status", "=", "pending")
          .where("app.kind", "=", "actor")
          .execute()
      : Promise.resolve([]),
    viewerWorkspaceMember
      ? db
          .selectFrom("workspaceAppGrantRequests as app_request")
          .innerJoin(
            "workspaceApps as app",
            "app.id",
            "app_request.workspaceAppId"
          )
          .select(["app_request.workspaceAppId as remoteAgentId"])
          .where("app_request.workspaceId", "=", params.workspaceId)
          .where(
            "app_request.requesterWorkspaceMemberId",
            "=",
            viewerWorkspaceMember.workspaceMemberId
          )
          .where("app_request.status", "=", "pending")
          .where("app.kind", "=", "remote_agent")
          .execute()
      : Promise.resolve([]),
  ])

  const pendingActorAccessIds = new Set(
    pendingActorAccessRows
      .map((row) => row.actorId)
      .filter((id): id is string => !!id)
  )
  const pendingRemoteAgentAccessIds = new Set(
    pendingRemoteAgentAccessRows
      .map((row) => row.remoteAgentId)
      .filter((id): id is string => !!id)
  )

  const workspaceMembers = members.map((row) =>
    mapWorkspaceMemberEntry({
      member: {
        workspace: workspaceSummary(row),
        workspaceMemberId: row.workspaceMemberId,
        userId: row.userId,
        trustLevel: row.trustLevel,
        name: row.name,
        email: row.email,
        avatarFileId: row.avatarFileId,
      },
      conversationId: directConversationMap.get(
        directConversationIdentityKey({
          kind: "workspace_member",
          workspaceMemberId: row.workspaceMemberId,
        })
      ),
    })
  )

  const actorApprovalRequirements = await deriveRequiresContactApprovalMany(
    db,
    "actor",
    params.workspaceId,
    actors.map((row) => row.actorId)
  )
  const workspaceActors: ContactHubEntry[] = []
  for (const row of actors) {
    const actor: ActorSummary = {
      workspace: workspaceSummary(row),
      actorId: row.actorId,
      displayName: row.displayName,
      title: row.title,
      role: row.role,
      avatarFileId: row.avatarFileId,
      avatarEmoji: row.avatarEmoji,
      requiresContactApproval:
        actorApprovalRequirements.get(row.actorId) ?? true,
      isPublicShared: Boolean(row.isPublicShared),
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

  const remoteAgentApprovalRequirements =
    await deriveRequiresContactApprovalMany(
      db,
      "remote_agent",
      params.workspaceId,
      remoteAgentsResult.rows.map((row) => row.remoteAgentId)
    )
  const workspaceRemoteAgents: ContactHubEntry[] = []
  for (const row of remoteAgentsResult.rows) {
    const remoteAgent: RemoteAgentSummary = {
      workspace: workspaceSummary(row),
      remoteAgentId: row.remoteAgentId,
      displayName: row.displayName,
      title: row.title,
      runtimeKind: row.runtimeKind,
      avatarFileId: row.avatarFileId,
      avatarEmoji: row.avatarEmoji,
      requiresContactApproval:
        remoteAgentApprovalRequirements.get(row.remoteAgentId) ?? true,
      isPublicShared: Boolean(row.isPublicShared),
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
    if (entry.peerKind === "workspace_member" && entry.peerWorkspaceMemberId) {
      const peer = await getWorkspaceMemberSummaryById(
        entry.peerWorkspaceMemberId
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
    if (entry.peerKind === "actor" && entry.peerActorId) {
      const actor = await getActorSummary(entry.peerActorId)
      if (!actor) continue
      friends.push(
        mapActorFriendEntry({
          entryId: entry.id,
          actor,
          conversationId: directConversationMap.get(
            directConversationIdentityKey({
              kind: "actor",
              actorId: entry.peerActorId,
            })
          ),
        })
      )
      continue
    }
    if (entry.peerKind === "remote_agent" && entry.peerRemoteAgentId) {
      const remoteAgent = await getRemoteAgentSummary(entry.peerRemoteAgentId)
      if (!remoteAgent) continue
      friends.push(
        mapRemoteAgentFriendEntry({
          entryId: entry.id,
          remoteAgent,
          conversationId: directConversationMap.get(
            directConversationIdentityKey({
              kind: "remote_agent",
              remoteAgentId: entry.peerRemoteAgentId,
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
    workspaceId: string
    subjectType: string
    subjectWorkspaceMemberId: string | null
    approvalMode: ApprovalMode
  }
}) {
  if (
    !params.profile.subjectWorkspaceMemberId ||
    params.profile.subjectWorkspaceMemberId === params.viewerWorkspaceMemberId
  ) {
    return { outcome: "self_scan" as const }
  }

  const member = await getWorkspaceMemberSummaryById(
    params.profile.subjectWorkspaceMemberId
  )
  if (!member) {
    throw new Error("Relationship profile target not found")
  }

  if (params.profile.workspaceId === params.workspaceId) {
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
    peerWorkspaceMemberId: params.profile.subjectWorkspaceMemberId,
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

  if (params.profile.approvalMode === "auto") {
    await createOrApproveFriendship({
      requesterWorkspaceMemberId: params.viewerWorkspaceMemberId,
      targetType: "workspace_member",
      targetWorkspaceMemberId: params.profile.subjectWorkspaceMemberId,
    })
    const entry = await findExistingFriendEntry({
      workspaceId: params.workspaceId,
      ownerWorkspaceMemberId: params.viewerWorkspaceMemberId,
      peerType: "workspace_member",
      peerWorkspaceMemberId: params.profile.subjectWorkspaceMemberId,
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
    targetWorkspaceMemberId: params.profile.subjectWorkspaceMemberId,
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
    .selectFrom("workspaceRelationshipProfiles as p")
    .innerJoin("accessSubjects as s", "s.id", "p.subjectId")
    .select([
      "p.id",
      "p.workspaceId",
      "p.subjectId",
      "p.identityId",
      "p.identitySearchEnabled",
      "p.approvalMode",
      "p.qrToken",
      "p.createdByWorkspaceMemberId",
      "p.createdAt",
      "p.updatedAt",
      "s.kind as subjectType",
      "s.workspaceMemberId as subjectWorkspaceMemberId",
      "s.actorId as subjectActorId",
      "s.remoteAgentId as subjectRemoteAgentId",
    ])
    .where("p.identityId", "=", normalizedQuery)
    .where("p.identitySearchEnabled", "=", true)
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

  if (profile.subjectType === "workspace_member") {
    if (
      profile.subjectWorkspaceMemberId ===
      viewerWorkspaceMember.workspaceMemberId
    ) {
      return {
        query: normalizedQuery,
        outcome: "self" as IdentitySearchOutcome,
        matches: [],
      }
    }

    const member = profile.subjectWorkspaceMemberId
      ? await getWorkspaceMemberSummaryById(profile.subjectWorkspaceMemberId)
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

  if (profile.subjectType === "remote_agent") {
    const remoteAgent = profile.subjectRemoteAgentId
      ? await getRemoteAgentSummary(profile.subjectRemoteAgentId)
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
      const pendingRemoteAgentRequest = await sql<{ id: string }>`
          SELECT id
          FROM workspace_app_grant_requests
          WHERE workspace_id = ${params.workspaceId}
            AND workspace_app_id = ${remoteAgent.remoteAgentId}
            AND requester_workspace_member_id = ${viewerWorkspaceMember.workspaceMemberId}
            AND status = 'pending'
          LIMIT 1
        `.execute(db)
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
            title: remoteAgent.displayName,
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
            title: remoteAgent.displayName,
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
          title: remoteAgent.displayName,
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

  const actor = profile.subjectActorId
    ? await getActorSummary(profile.subjectActorId)
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
    const pendingActorRequest = await db
      .selectFrom("workspaceAppGrantRequests")
      .select(["id"])
      .where("workspaceId", "=", params.workspaceId)
      .where("workspaceAppId", "=", actor.actorId)
      .where(
        "requesterWorkspaceMemberId",
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
          title: actor.displayName,
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
          title: actor.displayName,
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
        title: actor.displayName,
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
    .selectFrom("workspaceRelationshipProfiles as p")
    .innerJoin("accessSubjects as s", "s.id", "p.subjectId")
    .select([
      "p.id",
      "p.workspaceId",
      "p.subjectId",
      "p.identityId",
      "p.identitySearchEnabled",
      "p.approvalMode",
      "p.qrToken",
      "p.createdByWorkspaceMemberId",
      "p.createdAt",
      "p.updatedAt",
      "s.kind as subjectType",
      "s.workspaceMemberId as subjectWorkspaceMemberId",
      "s.actorId as subjectActorId",
      "s.remoteAgentId as subjectRemoteAgentId",
    ])
    .where("p.id", "=", params.profileId)
    .executeTakeFirst()
  if (!profile) {
    throw new Error("Search target not found")
  }
  if (params.requireSearchable !== false && !profile.identitySearchEnabled) {
    throw new Error("Search target not found")
  }

  if (profile.subjectType === "workspace_member") {
    return resolveMemberRelationshipProfile({
      workspaceId: params.workspaceId,
      userId: params.userId,
      viewerWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
      profile: {
        id: profile.id,
        workspaceId: profile.workspaceId,
        subjectType: profile.subjectType,
        subjectWorkspaceMemberId: profile.subjectWorkspaceMemberId,
        approvalMode: profile.approvalMode as ApprovalMode,
      },
    })
  }

  if (profile.subjectType === "remote_agent") {
    const remoteAgent = profile.subjectRemoteAgentId
      ? await getRemoteAgentSummary(profile.subjectRemoteAgentId)
      : null
    if (!remoteAgent) {
      throw new Error("Relationship profile target not found")
    }

    if (profile.workspaceId === params.workspaceId) {
      const canSee = await hasWorkspaceAppContactVisible({
        workspaceId: params.workspaceId,
        userId: params.userId,
        workspaceAppId: remoteAgent.remoteAgentId,
      })

      if (canSee) {
        return {
          outcome: "remote_agent_access_granted" as const,
          contact: {
            kind: "workspace-remote-agent" as const,
            id: remoteAgent.remoteAgentId,
          },
        }
      }

      if (profile.approvalMode === "auto") {
        await grantRemoteAgentContactVisibilityToMember({
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

    if (profile.approvalMode === "auto") {
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

  const actor = profile.subjectActorId
    ? await getActorSummary(profile.subjectActorId)
    : null
  if (!actor) {
    throw new Error("Relationship profile target not found")
  }

  if (profile.workspaceId === params.workspaceId) {
    const canSee = await hasWorkspaceAppContactVisible({
      workspaceId: params.workspaceId,
      userId: params.userId,
      workspaceAppId: actor.actorId,
    })

    if (canSee) {
      return {
        outcome: "actor_access_granted" as const,
        contact: {
          kind: "workspace-actor" as const,
          id: actor.actorId,
        },
      }
    }

    if (profile.approvalMode === "auto") {
      await grantActorContactVisibilityToMember({
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

  if (profile.approvalMode === "auto") {
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
    approvalMode: profile.approvalMode,
    qrToken: profile.qrToken,
    qrUrl: buildRelationshipQrUrl(profile.qrToken),
    identityId: profile.identityId,
    identitySearchEnabled: profile.identitySearchEnabled,
    requiresContactApproval: false,
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
      .updateTable("workspaceRelationshipProfiles")
      .set({
        approvalMode: params.approvalMode,
        identityId:
          typeof params.identityId === "string"
            ? validateIdentityId(params.identityId)
            : profile.identityId,
        identitySearchEnabled:
          typeof params.identitySearchEnabled === "boolean"
            ? params.identitySearchEnabled
            : profile.identitySearchEnabled,
      })
      .where("id", "=", profile.id)
      .returningAll()
      .executeTakeFirst()
    if (!updated) {
      throw new Error("Failed to update relationship profile")
    }
    return {
      subjectType: RELATIONSHIP_PROFILE_SUBJECT_TYPE.MEMBER,
      approvalMode: updated.approvalMode,
      qrToken: updated.qrToken,
      qrUrl: buildRelationshipQrUrl(updated.qrToken),
      identityId: updated.identityId,
      identitySearchEnabled: updated.identitySearchEnabled,
      requiresContactApproval: false,
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
    approvalMode: profile.approvalMode,
    qrToken: profile.qrToken,
    qrUrl: buildRelationshipQrUrl(profile.qrToken),
    identityId: profile.identityId,
    identitySearchEnabled: profile.identitySearchEnabled,
    requiresContactApproval: actor.requiresContactApproval,
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
    approvalMode: profile.approvalMode,
    qrToken: profile.qrToken,
    qrUrl: buildRelationshipQrUrl(profile.qrToken),
    identityId: profile.identityId,
    identitySearchEnabled: profile.identitySearchEnabled,
    requiresContactApproval: remoteAgent.requiresContactApproval,
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
      .updateTable("workspaceRelationshipProfiles")
      .set({
        approvalMode: params.approvalMode,
        identityId:
          typeof params.identityId === "string"
            ? validateIdentityId(params.identityId)
            : profile.identityId,
        identitySearchEnabled:
          typeof params.identitySearchEnabled === "boolean"
            ? params.identitySearchEnabled
            : profile.identitySearchEnabled,
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
  let requiresContactApproval = actorSummary?.requiresContactApproval ?? false
  let isPublicShared = actorSummary?.isPublicShared ?? false
  if (typeof params.isPublicShared === "boolean") {
    const actorResult = await db
      .updateTable("actors")
      .set({
        isPublicShared: params.isPublicShared,
      })
      .where("id", "=", params.actorId)
      .where((eb) =>
        eb.exists(
          db
            .selectFrom("workspaceAppsLive as app")
            .select("app.id")
            .where("app.id", "=", params.actorId)
            .where("app.workspaceId", "=", params.workspaceId)
            .where("app.deletedAt", "is", null)
        )
      )
      .returning(["isPublicShared"])
      .executeTakeFirst()
    if (!actorResult) {
      throw new Error("Actor not found")
    }
    isPublicShared = Boolean(actorResult.isPublicShared)
  }

  return {
    subjectType: RELATIONSHIP_PROFILE_SUBJECT_TYPE.ACTOR,
    approvalMode: updatedProfile.approvalMode,
    qrToken: updatedProfile.qrToken,
    qrUrl: buildRelationshipQrUrl(updatedProfile.qrToken),
    identityId: updatedProfile.identityId,
    identitySearchEnabled: updatedProfile.identitySearchEnabled,
    requiresContactApproval,
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
      .updateTable("workspaceRelationshipProfiles")
      .set({
        approvalMode: params.approvalMode,
        identityId:
          typeof params.identityId === "string"
            ? validateIdentityId(params.identityId)
            : profile.identityId,
        identitySearchEnabled:
          typeof params.identitySearchEnabled === "boolean"
            ? params.identitySearchEnabled
            : profile.identitySearchEnabled,
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
  let requiresContactApproval =
    remoteAgentSummary?.requiresContactApproval ?? false
  let isPublicShared = remoteAgentSummary?.isPublicShared ?? false

  if (typeof params.isPublicShared === "boolean") {
    const updateResult = await sql<{ isPublicShared: boolean }>`
        UPDATE remote_agents
        SET is_public_shared = ${params.isPublicShared},
            updated_at = NOW()
        WHERE id = ${params.remoteAgentId}
          AND EXISTS (
            SELECT 1
            FROM workspace_apps_live app
            WHERE app.id = remote_agents.id
              AND app.workspace_id = ${params.workspaceId}
              AND app.deleted_at IS NULL
              AND app.status = 'active'
          )
        RETURNING is_public_shared
      `.execute(db)
    if (!updateResult.rows[0]) {
      throw new Error("Remote agent not found")
    }
    isPublicShared = Boolean(updateResult.rows[0].isPublicShared)
  }

  return {
    subjectType: RELATIONSHIP_PROFILE_SUBJECT_TYPE.REMOTE_AGENT,
    approvalMode: updatedProfile.approvalMode,
    qrToken: updatedProfile.qrToken,
    qrUrl: buildRelationshipQrUrl(updatedProfile.qrToken),
    identityId: updatedProfile.identityId,
    identitySearchEnabled: updatedProfile.identitySearchEnabled,
    requiresContactApproval,
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
    .selectFrom("workspaceRelationshipProfiles as p")
    .innerJoin("accessSubjects as s", "s.id", "p.subjectId")
    .select([
      "p.id",
      "p.workspaceId",
      "p.subjectId",
      "p.identityId",
      "p.identitySearchEnabled",
      "p.approvalMode",
      "p.qrToken",
      "p.createdByWorkspaceMemberId",
      "p.createdAt",
      "p.updatedAt",
      "s.kind as subjectType",
      "s.workspaceMemberId as subjectWorkspaceMemberId",
      "s.actorId as subjectActorId",
      "s.remoteAgentId as subjectRemoteAgentId",
    ])
    .where("p.qrToken", "=", params.token)
    .executeTakeFirst()
  if (!profile) {
    throw new Error("Relationship QR code not found")
  }

  if (profile.subjectType === "workspace_member") {
    return resolveMemberRelationshipProfile({
      workspaceId: params.workspaceId,
      userId: params.userId,
      viewerWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
      profile: {
        id: profile.id,
        workspaceId: profile.workspaceId,
        subjectType: profile.subjectType,
        subjectWorkspaceMemberId: profile.subjectWorkspaceMemberId,
        approvalMode: profile.approvalMode as ApprovalMode,
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
    .selectFrom("workspaceFriendRequests as r")
    .innerJoin("accessSubjects as s", "s.id", "r.targetSubjectId")
    .select([
      "r.id",
      "r.requesterWorkspaceMemberId",
      "r.targetSubjectId",
      "r.requestedViaProfileId",
      "r.status",
      "r.resolvedByWorkspaceMemberId",
      "r.resolvedAt",
      "r.createdAt",
      "r.updatedAt",
      "s.kind as targetKind",
      "s.workspaceMemberId as targetWorkspaceMemberId",
      "s.actorId as targetActorId",
      "s.remoteAgentId as targetRemoteAgentId",
    ])
    .where("r.status", "=", "pending")
    .orderBy("r.createdAt", "desc")
    .execute()
  const outgoingRows = pendingRows.filter(
    (row) =>
      row.requesterWorkspaceMemberId === viewerWorkspaceMember.workspaceMemberId
  )

  const incoming = []
  for (const row of pendingRows) {
    if (row.targetKind === "workspace_member") {
      if (
        row.targetWorkspaceMemberId !== viewerWorkspaceMember.workspaceMemberId
      ) {
        continue
      }
    } else if (row.targetKind === "actor" && row.targetActorId) {
      const targetActor = await getActorSummary(row.targetActorId)
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
        resourceId: row.targetActorId,
      })
      if (!canApprove) continue
    } else if (row.targetKind === "remote_agent" && row.targetRemoteAgentId) {
      const targetRemoteAgent = await getRemoteAgentSummary(
        row.targetRemoteAgentId
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
        resourceId: row.targetRemoteAgentId,
      })
      if (!canApprove) continue
    }

    const requester = await getWorkspaceMemberSummaryById(
      row.requesterWorkspaceMemberId
    )
    const targetMember =
      row.targetKind === "workspace_member" && row.targetWorkspaceMemberId
        ? await getWorkspaceMemberSummaryById(row.targetWorkspaceMemberId)
        : null
    const targetActor =
      row.targetKind === "actor" && row.targetActorId
        ? await getActorSummary(row.targetActorId)
        : null
    const targetRemoteAgent =
      row.targetKind === "remote_agent" && row.targetRemoteAgentId
        ? await getRemoteAgentSummary(row.targetRemoteAgentId)
        : null
    incoming.push({
      id: row.id,
      status: row.status,
      createdAt: serializeOptionalInstant(row.createdAt),
      requester,
      targetType: subjectKindToRelationshipPeerType(row.targetKind),
      targetMember,
      targetActor,
      targetRemoteAgent,
    })
  }

  const outgoing = []
  for (const row of outgoingRows) {
    const targetMember =
      row.targetKind === "workspace_member" && row.targetWorkspaceMemberId
        ? await getWorkspaceMemberSummaryById(row.targetWorkspaceMemberId)
        : null
    const targetActor =
      row.targetKind === "actor" && row.targetActorId
        ? await getActorSummary(row.targetActorId)
        : null
    const targetRemoteAgent =
      row.targetKind === "remote_agent" && row.targetRemoteAgentId
        ? await getRemoteAgentSummary(row.targetRemoteAgentId)
        : null
    outgoing.push({
      id: row.id,
      status: row.status,
      createdAt: serializeOptionalInstant(row.createdAt),
      targetType: subjectKindToRelationshipPeerType(row.targetKind),
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
    .selectFrom("workspaceFriendRequests as r")
    .innerJoin("accessSubjects as s", "s.id", "r.targetSubjectId")
    .select([
      "r.id",
      "r.requesterWorkspaceMemberId",
      "r.targetSubjectId",
      "r.requestedViaProfileId",
      "r.status",
      "r.resolvedByWorkspaceMemberId",
      "r.resolvedAt",
      "r.createdAt",
      "r.updatedAt",
      "s.kind as targetSubjectType",
      "s.workspaceMemberId as targetWorkspaceMemberId",
      "s.actorId as targetActorId",
      "s.remoteAgentId as targetRemoteAgentId",
    ])
    .where("r.id", "=", params.requestId)
    .executeTakeFirst()
  if (!request) {
    throw new Error("Friend request not found")
  }
  if (request.status !== "pending") {
    throw new Error("Friend request has already been resolved")
  }

  if (request.targetSubjectType === "workspace_member") {
    if (
      request.targetWorkspaceMemberId !==
      viewerWorkspaceMember.workspaceMemberId
    ) {
      throw new Error("Not allowed to resolve this friend request")
    }
  } else if (request.targetSubjectType === "actor" && request.targetActorId) {
    const targetActor = await getActorSummary(request.targetActorId)
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
      resourceId: request.targetActorId,
    })
    if (!canApprove) {
      throw new Error("Not allowed to resolve this friend request")
    }
  } else if (
    request.targetSubjectType === "remote_agent" &&
    request.targetRemoteAgentId
  ) {
    const targetRemoteAgent = await getRemoteAgentSummary(
      request.targetRemoteAgentId
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
      resourceId: request.targetRemoteAgentId,
    })
    if (!canApprove) {
      throw new Error("Not allowed to resolve this friend request")
    }
  }

  if (params.decision === "approve") {
    await createOrApproveFriendship({
      requesterWorkspaceMemberId: request.requesterWorkspaceMemberId,
      targetType: subjectKindToRelationshipPeerType(request.targetSubjectType),
      targetWorkspaceMemberId: request.targetWorkspaceMemberId || undefined,
      targetActorId: request.targetActorId || undefined,
      targetRemoteAgentId: request.targetRemoteAgentId || undefined,
      sourceRequestId: request.id,
    })
  }

  const updated = await db
    .updateTable("workspaceFriendRequests")
    .set({
      status: params.decision === "approve" ? "approved" : "rejected",
      resolvedByWorkspaceMemberId: viewerWorkspaceMember.workspaceMemberId,
      resolvedAt: sql`NOW()`,
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
  const [incomingRows, outgoingRows] = await Promise.all([
    db
      .selectFrom("workspaceAppGrantRequests as app_request")
      .innerJoin("workspaceApps as app", "app.id", "app_request.workspaceAppId")
      .select([
        "app_request.id",
        "app_request.workspaceId",
        "app_request.requesterWorkspaceMemberId",
        "app_request.status",
        "app_request.resolvedByWorkspaceMemberId",
        "app_request.resolvedAt",
        "app_request.createdAt",
        "app_request.updatedAt",
        "app_request.workspaceAppId as actorId",
      ])
      .where("app_request.workspaceId", "=", params.workspaceId)
      .where("app_request.status", "=", "pending")
      .where("app.kind", "=", "actor")
      .execute(),
    db
      .selectFrom("workspaceAppGrantRequests as app_request")
      .innerJoin("workspaceApps as app", "app.id", "app_request.workspaceAppId")
      .select([
        "app_request.id",
        "app_request.workspaceId",
        "app_request.requesterWorkspaceMemberId",
        "app_request.status",
        "app_request.resolvedByWorkspaceMemberId",
        "app_request.resolvedAt",
        "app_request.createdAt",
        "app_request.updatedAt",
        "app_request.workspaceAppId as actorId",
      ])
      .where("app_request.workspaceId", "=", params.workspaceId)
      .where(
        "app_request.requesterWorkspaceMemberId",
        "=",
        viewerWorkspaceMember.workspaceMemberId
      )
      .where("app_request.status", "=", "pending")
      .where("app.kind", "=", "actor")
      .execute(),
  ])

  const incoming = []
  for (const row of incomingRows) {
    if (!row.actorId) continue
    const canApprove = await authorizeAction(db, {
      subject: await resolveWorkspaceAccessSubject(
        db,
        params.workspaceId,
        params.userId
      ),
      action: "actor.grant",
      resourceId: row.actorId,
    })
    if (!canApprove) continue
    incoming.push({
      id: row.id,
      status: row.status,
      createdAt: serializeOptionalInstant(row.createdAt),
      requester: await getWorkspaceMemberSummaryById(
        row.requesterWorkspaceMemberId
      ),
      actor: await getActorSummary(row.actorId),
    })
  }

  const outgoing = []
  for (const row of outgoingRows) {
    if (!row.actorId) continue
    outgoing.push({
      id: row.id,
      status: row.status,
      createdAt: serializeOptionalInstant(row.createdAt),
      actor: await getActorSummary(row.actorId),
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
    sql<WorkspaceAppGrantRequestJoinRow>`
        SELECT request.id, request.workspace_id, request.requester_workspace_member_id,
               request.status, request.resolved_by_workspace_member_id, request.resolved_at,
               request.created_at, request.updated_at,
               request.workspace_app_id AS remote_agent_id
        FROM workspace_app_grant_requests request
        JOIN workspace_apps_live app ON app.id = request.workspace_app_id
        WHERE request.workspace_id = ${params.workspaceId}
          AND request.status = 'pending'
          AND app.kind = 'remote_agent'
        ORDER BY request.created_at DESC
      `
      .execute(db)
      .then((result) => result.rows),
    sql<WorkspaceAppGrantRequestJoinRow>`
        SELECT request.id, request.workspace_id, request.requester_workspace_member_id,
               request.status, request.resolved_by_workspace_member_id, request.resolved_at,
               request.created_at, request.updated_at,
               request.workspace_app_id AS remote_agent_id
        FROM workspace_app_grant_requests request
        JOIN workspace_apps_live app ON app.id = request.workspace_app_id
        WHERE request.workspace_id = ${params.workspaceId}
          AND request.requester_workspace_member_id = ${viewerWorkspaceMember.workspaceMemberId}
          AND request.status = 'pending'
          AND app.kind = 'remote_agent'
        ORDER BY request.created_at DESC
      `
      .execute(db)
      .then((result) => result.rows),
  ])

  const incoming = []
  for (const row of incomingRows) {
    if (!row.remoteAgentId) continue
    const remoteAgentId = row.remoteAgentId
    const canApprove = await authorizeAction(db, {
      subject: await resolveWorkspaceAccessSubject(
        db,
        params.workspaceId,
        params.userId
      ),
      action: "remote_agent.grant",
      resourceId: remoteAgentId,
    })
    if (!canApprove) continue
    incoming.push({
      id: row.id,
      status: row.status,
      createdAt: serializeOptionalInstant(row.createdAt),
      requester: await getWorkspaceMemberSummaryById(
        row.requesterWorkspaceMemberId
      ),
      remoteAgent: await getRemoteAgentSummary(remoteAgentId),
    })
  }

  const outgoing = []
  for (const row of outgoingRows) {
    if (!row.remoteAgentId) continue
    outgoing.push({
      id: row.id,
      status: row.status,
      createdAt: serializeOptionalInstant(row.createdAt),
      remoteAgent: await getRemoteAgentSummary(row.remoteAgentId),
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
    .selectFrom("workspaceAppGrantRequests as app_request")
    .innerJoin("workspaceApps as app", "app.id", "app_request.workspaceAppId")
    .select([
      "app_request.id",
      "app_request.workspaceId",
      "app_request.workspaceAppId as actorId",
      "app_request.requesterWorkspaceMemberId",
      "app_request.status",
      "app.kind as targetKind",
    ])
    .where("app_request.id", "=", params.requestId)
    .executeTakeFirst()
  if (
    !request ||
    request.workspaceId !== params.workspaceId ||
    request.targetKind !== WORKSPACE_APP_KIND.ACTOR ||
    !request.actorId
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
    resourceId: request.actorId,
  })
  if (!canApprove) {
    throw new Error("Not allowed to resolve this actor access request")
  }

  return resolveWorkspaceAppGrantRequest({
    workspaceId: params.workspaceId,
    workspaceAppId: request.actorId,
    requestId: request.id,
    approverWorkspaceMemberId: approverWorkspaceMember.workspaceMemberId,
    decision: params.decision,
  })
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

  const requestResult = await sql<{
    id: string
    workspaceId: string
    requesterWorkspaceMemberId: string
    status: string
    resolvedAt: Date | null
    resolvedByWorkspaceMemberId: string | null
    remoteAgentId: string | null
    targetKind: string
  }>`
      SELECT request.id, request.workspace_id, request.requester_workspace_member_id,
             request.status, request.resolved_at, request.resolved_by_workspace_member_id,
             request.workspace_app_id AS remote_agent_id, app.kind AS target_kind
      FROM workspace_app_grant_requests request
      JOIN workspace_apps_live app ON app.id = request.workspace_app_id
      WHERE request.id = ${params.requestId}
      LIMIT 1
    `.execute(db)
  const request = requestResult.rows[0]
  if (
    !request ||
    request.workspaceId !== params.workspaceId ||
    request.targetKind !== WORKSPACE_APP_KIND.REMOTE_AGENT ||
    !request.remoteAgentId
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
    resourceId: request.remoteAgentId,
  })
  if (!canApprove) {
    throw new Error("Not allowed to resolve this remote agent access request")
  }

  return resolveWorkspaceAppGrantRequest({
    workspaceId: params.workspaceId,
    workspaceAppId: request.remoteAgentId,
    requestId: request.id,
    approverWorkspaceMemberId: approverWorkspaceMember.workspaceMemberId,
    decision: params.decision,
  })
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
            createdAt: thread.createdAt,
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
    const canSee = await hasWorkspaceAppContactVisible({
      workspaceId: params.workspaceId,
      userId: params.userId,
      workspaceAppId: resolved.actor.actorId,
    })

    if (!canSee && resolved.actor.requiresContactApproval) {
      const profile = await ensureRelationshipProfile({
        workspaceId: params.workspaceId,
        createdByWorkspaceMemberId: requesterWorkspaceMember.workspaceMemberId,
        subjectType: RELATIONSHIP_PROFILE_SUBJECT_TYPE.ACTOR,
        subjectActorId: resolved.actor.actorId,
      })
      if (profile.approvalMode === RELATIONSHIP_APPROVAL_MODE.AUTO) {
        await grantActorContactVisibilityToMember({
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
    const canSee = await hasWorkspaceAppContactVisible({
      workspaceId: params.workspaceId,
      userId: params.userId,
      workspaceAppId: resolved.remoteAgent.remoteAgentId,
    })

    if (!canSee && resolved.remoteAgent.requiresContactApproval) {
      const profile = await ensureRelationshipProfile({
        workspaceId: params.workspaceId,
        createdByWorkspaceMemberId: requesterWorkspaceMember.workspaceMemberId,
        subjectType: RELATIONSHIP_PROFILE_SUBJECT_TYPE.REMOTE_AGENT,
        subjectRemoteAgentId: resolved.remoteAgent.remoteAgentId,
      })
      if (profile.approvalMode === RELATIONSHIP_APPROVAL_MODE.AUTO) {
        await grantRemoteAgentContactVisibilityToMember({
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
      .insertInto("directConversationBindings")
      .values({
        conversationId: created.conversation.conversationId,
        participantOneSubjectId: directBindingValues.participant_one_subject_id,
        participantTwoSubjectId: directBindingValues.participant_two_subject_id,
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
