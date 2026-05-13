export type DirectConversationIdentity =
  | {
      kind: "member"
      workspaceMemberId: string
    }
  | {
      kind: "actor"
      actorId: string
    }
  | {
      kind: "remote_agent"
      remoteAgentId: string
    }

export function directConversationIdentityKey(
  identity: DirectConversationIdentity
) {
  if (identity.kind === "member") {
    return `workspace_member:${identity.workspaceMemberId}`
  }
  if (identity.kind === "remote_agent") {
    return `remote_agent:${identity.remoteAgentId}`
  }
  return `actor:${identity.actorId}`
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
    pair.participantOne.kind === "member"
      ? {
          participant_one_kind: "member" as const,
          participant_one_workspace_member_id:
            pair.participantOne.workspaceMemberId,
          participant_one_actor_id: null,
          participant_one_remote_agent_id: null,
        }
      : pair.participantOne.kind === "actor"
        ? {
            participant_one_kind: "actor" as const,
            participant_one_workspace_member_id: null,
            participant_one_actor_id: pair.participantOne.actorId,
            participant_one_remote_agent_id: null,
          }
        : {
            participant_one_kind: "remote_agent" as const,
            participant_one_workspace_member_id: null,
            participant_one_actor_id: null,
            participant_one_remote_agent_id: pair.participantOne.remoteAgentId,
          }
  const participantTwo =
    pair.participantTwo.kind === "member"
      ? {
          participant_two_kind: "member" as const,
          participant_two_workspace_member_id:
            pair.participantTwo.workspaceMemberId,
          participant_two_actor_id: null,
          participant_two_remote_agent_id: null,
        }
      : pair.participantTwo.kind === "actor"
        ? {
            participant_two_kind: "actor" as const,
            participant_two_workspace_member_id: null,
            participant_two_actor_id: pair.participantTwo.actorId,
            participant_two_remote_agent_id: null,
          }
        : {
            participant_two_kind: "remote_agent" as const,
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
    participant_one_kind: "member" | "actor" | "remote_agent"
    participant_one_workspace_member_id: string | null
    participant_one_actor_id: string | null
    participant_one_remote_agent_id: string | null
    participant_two_kind: "member" | "actor" | "remote_agent"
    participant_two_workspace_member_id: string | null
    participant_two_actor_id: string | null
    participant_two_remote_agent_id: string | null
  },
  viewer: DirectConversationIdentity
): DirectConversationIdentity | null {
  const left =
    row.participant_one_kind === "member" &&
    row.participant_one_workspace_member_id
      ? {
          kind: "member" as const,
          workspaceMemberId: row.participant_one_workspace_member_id,
        }
      : row.participant_one_actor_id
        ? {
            kind: "actor" as const,
            actorId: row.participant_one_actor_id,
          }
        : row.participant_one_remote_agent_id
          ? {
              kind: "remote_agent" as const,
              remoteAgentId: row.participant_one_remote_agent_id,
            }
          : null
  const right =
    row.participant_two_kind === "member" &&
    row.participant_two_workspace_member_id
      ? {
          kind: "member" as const,
          workspaceMemberId: row.participant_two_workspace_member_id,
        }
      : row.participant_two_actor_id
        ? {
            kind: "actor" as const,
            actorId: row.participant_two_actor_id,
          }
        : row.participant_two_remote_agent_id
          ? {
              kind: "remote_agent" as const,
              remoteAgentId: row.participant_two_remote_agent_id,
            }
          : null

  if (!left || !right) return null
  const viewerKey = directConversationIdentityKey(viewer)
  if (directConversationIdentityKey(left) === viewerKey) return right
  if (directConversationIdentityKey(right) === viewerKey) return left
  return null
}
