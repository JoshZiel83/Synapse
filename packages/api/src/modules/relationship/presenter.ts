import type {
  ContactHubDetailResponse,
  ContactHubEntryView,
  ContactHubResponse,
  ContactTargetType,
  ConversationSummaryView,
  DirectConversationOpenResponse,
  RelationshipActorSummaryView,
  RelationshipMemberSummaryView,
  RelationshipProfileView,
  RelationshipRemoteAgentSummaryView,
  RelationshipRequestStatus,
} from "@synapse/shared"
import { RELATIONSHIP_REQUEST_STATUS } from "@synapse/shared"
import { serializeInstant } from "../../infrastructure/datetime.js"

/**
 * Relationship presentation layer: DB row → app-facing view. Owns the outward
 * semantic transforms (Date → IsoInstantString) so the service/controller
 * never call serializeInstant/serializeOptionalInstant (guard-layering r3).
 * See §5.1 / §10.1.
 *
 * The *Record types below are the domain-record shapes the service produces and
 * the presenter consumes (controller maps record → View right before send).
 */

export type RelationshipMemberSummaryRecord = RelationshipMemberSummaryView
export type RelationshipActorSummaryRecord = RelationshipActorSummaryView
export type RelationshipRemoteAgentSummaryRecord =
  RelationshipRemoteAgentSummaryView
export type ContactHubEntryRecord = ContactHubEntryView
export type ConversationSummaryRecord = ConversationSummaryView

export type FriendRequestRecord = {
  id: string
  status: RelationshipRequestStatus
  createdAt: Date
  targetType: ContactTargetType
  requester?: RelationshipMemberSummaryRecord | null
  targetMember?: RelationshipMemberSummaryRecord | null
  targetActor?: RelationshipActorSummaryRecord | null
  targetRemoteAgent?: RelationshipRemoteAgentSummaryRecord | null
}

export type ActorAccessRequestRecord = {
  id: string
  status: RelationshipRequestStatus
  createdAt: Date
  requester?: RelationshipMemberSummaryRecord | null
  actor?: RelationshipActorSummaryRecord | null
}

export type RemoteAgentAccessRequestRecord = {
  id: string
  status: RelationshipRequestStatus
  createdAt: Date
  requester?: RelationshipMemberSummaryRecord | null
  remoteAgent?: RelationshipRemoteAgentSummaryRecord | null
}

export type FriendRequestListRecord = {
  incoming: FriendRequestRecord[]
  outgoing: FriendRequestRecord[]
}

export type ActorAccessRequestListRecord = {
  incoming: ActorAccessRequestRecord[]
  outgoing: ActorAccessRequestRecord[]
}

export type RemoteAgentAccessRequestListRecord = {
  incoming: RemoteAgentAccessRequestRecord[]
  outgoing: RemoteAgentAccessRequestRecord[]
}

export type RelationshipProfileRecord = Omit<RelationshipProfileView, "qrUrl">

export type ContactHubRequestSummaryRecord = {
  friendPendingCount: number
  actorAccessPendingCount: number
  remoteAgentAccessPendingCount: number
  totalPendingCount: number
}

export type ContactHubRecord = {
  requestSummary: ContactHubRequestSummaryRecord
  workspaceActors: ContactHubEntryRecord[]
  workspaceRemoteAgents: ContactHubEntryRecord[]
  workspaceMembers: ContactHubEntryRecord[]
  friends: ContactHubEntryRecord[]
  groups: ConversationSummaryRecord[]
}

export type ContactHubDetailRecord = {
  contact: ContactHubEntryRecord
  groups: ConversationSummaryRecord[]
}

export type DirectConversationOpenRecord = {
  status: DirectConversationOpenResponse["status"]
  created?: boolean
  conversationId?: string
  requestId?: string
}

export type ResolvedRelationshipRequestRecord = {
  id: string
  status: string
}

type ResolvedRelationshipRequestStatus =
  | typeof RELATIONSHIP_REQUEST_STATUS.APPROVED
  | typeof RELATIONSHIP_REQUEST_STATUS.REJECTED

function assertResolvedRelationshipRequestStatus(
  status: string
): ResolvedRelationshipRequestStatus {
  if (
    status === RELATIONSHIP_REQUEST_STATUS.APPROVED ||
    status === RELATIONSHIP_REQUEST_STATUS.REJECTED
  ) {
    return status
  }
  throw new Error(`Unexpected resolved relationship request status: ${status}`)
}

function buildRelationshipQrUrl(token: string) {
  return `synapse://relationship-qr?token=${encodeURIComponent(token)}`
}

function presentMemberSummary(
  input: RelationshipMemberSummaryRecord | null | undefined
): RelationshipMemberSummaryView | null | undefined {
  return input ? { ...input, workspace: { ...input.workspace } } : input
}

function presentActorSummary(
  input: RelationshipActorSummaryRecord | null | undefined
): RelationshipActorSummaryView | null | undefined {
  return input ? { ...input, workspace: { ...input.workspace } } : input
}

function presentRemoteAgentSummary(
  input: RelationshipRemoteAgentSummaryRecord | null | undefined
): RelationshipRemoteAgentSummaryView | null | undefined {
  return input ? { ...input, workspace: { ...input.workspace } } : input
}

function presentContactHubEntry(
  input: ContactHubEntryRecord
): ContactHubEntryView {
  return {
    ...input,
    workspace: { ...input.workspace },
    directState: { ...input.directState },
  }
}

export function presentRelationshipProfile(
  input: RelationshipProfileRecord
): RelationshipProfileView {
  return {
    ...input,
    qrUrl: buildRelationshipQrUrl(input.qrToken),
  }
}

export function presentContactHub(input: ContactHubRecord): ContactHubResponse {
  return {
    requestSummary: {
      friendPendingCount: input.requestSummary.friendPendingCount,
      actorAccessPendingCount: input.requestSummary.actorAccessPendingCount,
      remoteAgentAccessPendingCount:
        input.requestSummary.remoteAgentAccessPendingCount,
      totalPendingCount: input.requestSummary.totalPendingCount,
    },
    workspaceActors: input.workspaceActors.map(presentContactHubEntry),
    workspaceRemoteAgents: input.workspaceRemoteAgents.map(
      presentContactHubEntry
    ),
    workspaceMembers: input.workspaceMembers.map(presentContactHubEntry),
    friends: input.friends.map(presentContactHubEntry),
    groups: input.groups,
  }
}

export function presentContactHubDetail(
  input: ContactHubDetailRecord
): ContactHubDetailResponse {
  return {
    contact: presentContactHubEntry(input.contact),
    groups: input.groups,
  }
}

export function presentDirectConversationOpen(
  input: DirectConversationOpenRecord
): DirectConversationOpenResponse {
  return {
    status: input.status,
    created: input.created,
    conversationId: input.conversationId,
    requestId: input.requestId,
  }
}

export function presentFriendRequest(input: FriendRequestRecord) {
  return {
    id: input.id,
    status: input.status,
    createdAt: serializeInstant(input.createdAt),
    requester: presentMemberSummary(input.requester),
    targetType: input.targetType,
    targetMember: presentMemberSummary(input.targetMember),
    targetActor: presentActorSummary(input.targetActor),
    targetRemoteAgent: presentRemoteAgentSummary(input.targetRemoteAgent),
  }
}

export function presentActorAccessRequest(input: ActorAccessRequestRecord) {
  return {
    id: input.id,
    status: input.status,
    createdAt: serializeInstant(input.createdAt),
    requester: presentMemberSummary(input.requester),
    actor: presentActorSummary(input.actor),
  }
}

export function presentRemoteAgentAccessRequest(
  input: RemoteAgentAccessRequestRecord
) {
  return {
    id: input.id,
    status: input.status,
    createdAt: serializeInstant(input.createdAt),
    requester: presentMemberSummary(input.requester),
    remoteAgent: presentRemoteAgentSummary(input.remoteAgent),
  }
}

export function presentResolvedRelationshipRequest(
  input: ResolvedRelationshipRequestRecord
) {
  return {
    request: {
      id: input.id,
      status: assertResolvedRelationshipRequestStatus(input.status),
    },
  }
}
