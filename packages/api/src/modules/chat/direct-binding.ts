import { CONVERSATION_PARTICIPANT_TYPE } from "@synapse/shared"

const PT = CONVERSATION_PARTICIPANT_TYPE

export const DIRECT_PARTICIPANT_KINDS = [
  PT.WORKSPACE_MEMBER,
  PT.ACTOR,
  PT.REMOTE_AGENT,
] as const
export type DirectParticipantKind = (typeof DIRECT_PARTICIPANT_KINDS)[number]

export type DirectConversationIdentity =
  | {
      kind: typeof PT.WORKSPACE_MEMBER
      workspaceMemberId: string
    }
  | {
      kind: typeof PT.ACTOR
      actorId: string
    }
  | {
      kind: typeof PT.REMOTE_AGENT
      remoteAgentId: string
    }

export function directConversationIdentityKey(
  identity: DirectConversationIdentity
) {
  if (identity.kind === PT.WORKSPACE_MEMBER) {
    return `${PT.WORKSPACE_MEMBER}:${identity.workspaceMemberId}`
  }
  if (identity.kind === PT.REMOTE_AGENT) {
    return `${PT.REMOTE_AGENT}:${identity.remoteAgentId}`
  }
  return `${PT.ACTOR}:${identity.actorId}`
}

export function canonicalizeDirectConversationPair(
  left: DirectConversationIdentity,
  right: DirectConversationIdentity
) {
  const leftKey = directConversationIdentityKey(left)
  const rightKey = directConversationIdentityKey(right)
  return leftKey <= rightKey
    ? { participantOne: left, participantTwo: right }
    : { participantOne: right, participantTwo: left }
}

export function directConversationBindingValues(
  pair: ReturnType<typeof canonicalizeDirectConversationPair>
) {
  const participantOne =
    pair.participantOne.kind === PT.WORKSPACE_MEMBER
      ? {
          participant_one_kind: PT.WORKSPACE_MEMBER,
          participant_one_workspace_member_id:
            pair.participantOne.workspaceMemberId,
          participant_one_actor_id: null,
          participant_one_remote_agent_id: null,
        }
      : pair.participantOne.kind === PT.ACTOR
        ? {
            participant_one_kind: PT.ACTOR,
            participant_one_workspace_member_id: null,
            participant_one_actor_id: pair.participantOne.actorId,
            participant_one_remote_agent_id: null,
          }
        : {
            participant_one_kind: PT.REMOTE_AGENT,
            participant_one_workspace_member_id: null,
            participant_one_actor_id: null,
            participant_one_remote_agent_id: pair.participantOne.remoteAgentId,
          }
  const participantTwo =
    pair.participantTwo.kind === PT.WORKSPACE_MEMBER
      ? {
          participant_two_kind: PT.WORKSPACE_MEMBER,
          participant_two_workspace_member_id:
            pair.participantTwo.workspaceMemberId,
          participant_two_actor_id: null,
          participant_two_remote_agent_id: null,
        }
      : pair.participantTwo.kind === PT.ACTOR
        ? {
            participant_two_kind: PT.ACTOR,
            participant_two_workspace_member_id: null,
            participant_two_actor_id: pair.participantTwo.actorId,
            participant_two_remote_agent_id: null,
          }
        : {
            participant_two_kind: PT.REMOTE_AGENT,
            participant_two_workspace_member_id: null,
            participant_two_actor_id: null,
            participant_two_remote_agent_id: pair.participantTwo.remoteAgentId,
          }

  return {
    ...participantOne,
    ...participantTwo,
  }
}

export function directConversationBindingPeer(
  row: {
    participant_one_kind: DirectParticipantKind
    participant_one_workspace_member_id: string | null
    participant_one_actor_id: string | null
    participant_one_remote_agent_id: string | null
    participant_two_kind: DirectParticipantKind
    participant_two_workspace_member_id: string | null
    participant_two_actor_id: string | null
    participant_two_remote_agent_id: string | null
  },
  viewer: DirectConversationIdentity
): DirectConversationIdentity | null {
  const left =
    row.participant_one_kind === PT.WORKSPACE_MEMBER &&
    row.participant_one_workspace_member_id
      ? {
          kind: PT.WORKSPACE_MEMBER,
          workspaceMemberId: row.participant_one_workspace_member_id,
        }
      : row.participant_one_actor_id
        ? {
            kind: PT.ACTOR,
            actorId: row.participant_one_actor_id,
          }
        : row.participant_one_remote_agent_id
          ? {
              kind: PT.REMOTE_AGENT,
              remoteAgentId: row.participant_one_remote_agent_id,
            }
          : null
  const right =
    row.participant_two_kind === PT.WORKSPACE_MEMBER &&
    row.participant_two_workspace_member_id
      ? {
          kind: PT.WORKSPACE_MEMBER,
          workspaceMemberId: row.participant_two_workspace_member_id,
        }
      : row.participant_two_actor_id
        ? {
            kind: PT.ACTOR,
            actorId: row.participant_two_actor_id,
          }
        : row.participant_two_remote_agent_id
          ? {
              kind: PT.REMOTE_AGENT,
              remoteAgentId: row.participant_two_remote_agent_id,
            }
          : null

  if (!left || !right) return null
  const viewerKey = directConversationIdentityKey(viewer)
  if (directConversationIdentityKey(left) === viewerKey) return right
  if (directConversationIdentityKey(right) === viewerKey) return left
  return null
}
