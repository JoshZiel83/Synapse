import type {
  ContactTargetType,
  RelationshipActorSummaryView,
  RelationshipMemberSummaryView,
  RelationshipRemoteAgentSummaryView,
} from "@synapse/shared"
import { serializeOptionalInstant } from "../../infrastructure/datetime.js"

/**
 * Relationship presentation layer: DB row → app-facing view. Owns the outward
 * semantic transforms (Date → IsoInstantString) so the service/controller
 * never call serializeInstant/serializeOptionalInstant (guard-layering r3).
 * See §5.1 / §10.1.
 *
 * The *Record types below are the domain-record shapes the service produces and
 * the presenter consumes (controller maps record → View right before send).
 */

export type FriendRequestRecord = {
  id: string
  status: string
  createdAt: Date | null | undefined
  targetType: ContactTargetType
  requester?: RelationshipMemberSummaryView | null
  targetMember?: RelationshipMemberSummaryView | null
  targetActor?: RelationshipActorSummaryView | null
  targetRemoteAgent?: RelationshipRemoteAgentSummaryView | null
}

export type ActorAccessRequestRecord = {
  id: string
  status: string
  createdAt: Date | null | undefined
  requester?: RelationshipMemberSummaryView | null
  actor?: RelationshipActorSummaryView | null
}

export type RemoteAgentAccessRequestRecord = {
  id: string
  status: string
  createdAt: Date | null | undefined
  requester?: RelationshipMemberSummaryView | null
  remoteAgent?: RelationshipRemoteAgentSummaryView | null
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

export function presentFriendRequest(input: FriendRequestRecord) {
  return {
    id: input.id,
    status: input.status,
    createdAt: serializeOptionalInstant(input.createdAt),
    requester: input.requester,
    targetType: input.targetType,
    targetMember: input.targetMember,
    targetActor: input.targetActor,
    targetRemoteAgent: input.targetRemoteAgent,
  }
}

export function presentActorAccessRequest(input: ActorAccessRequestRecord) {
  return {
    id: input.id,
    status: input.status,
    createdAt: serializeOptionalInstant(input.createdAt),
    requester: input.requester,
    actor: input.actor,
  }
}

export function presentRemoteAgentAccessRequest(
  input: RemoteAgentAccessRequestRecord
) {
  return {
    id: input.id,
    status: input.status,
    createdAt: serializeOptionalInstant(input.createdAt),
    requester: input.requester,
    remoteAgent: input.remoteAgent,
  }
}
