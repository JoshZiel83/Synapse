export type DirectConversationIdentity =
  | {
      kind: "user";
      workspaceMemberId: string;
    }
  | {
      kind: "actor";
      actorId: string;
    };

export function directConversationIdentityKey(
  identity: DirectConversationIdentity,
) {
  return identity.kind === "user"
    ? `workspace_member:${identity.workspaceMemberId}`
    : `actor:${identity.actorId}`;
}

export function canonicalizeDirectConversationPair(
  left: DirectConversationIdentity,
  right: DirectConversationIdentity,
) {
  const leftKey = directConversationIdentityKey(left);
  const rightKey = directConversationIdentityKey(right);
  return leftKey <= rightKey
    ? { participantOne: left, participantTwo: right }
    : { participantOne: right, participantTwo: left };
}

export function directConversationBindingValues(
  pair: ReturnType<typeof canonicalizeDirectConversationPair>,
) {
  const participantOne =
    pair.participantOne.kind === "user"
      ? {
          participant_one_kind: "user" as const,
          participant_one_workspace_member_id:
            pair.participantOne.workspaceMemberId,
          participant_one_actor_id: null,
        }
      : {
          participant_one_kind: "actor" as const,
          participant_one_workspace_member_id: null,
          participant_one_actor_id: pair.participantOne.actorId,
        };
  const participantTwo =
    pair.participantTwo.kind === "user"
      ? {
          participant_two_kind: "user" as const,
          participant_two_workspace_member_id:
            pair.participantTwo.workspaceMemberId,
          participant_two_actor_id: null,
        }
      : {
          participant_two_kind: "actor" as const,
          participant_two_workspace_member_id: null,
          participant_two_actor_id: pair.participantTwo.actorId,
        };

  return {
    ...participantOne,
    ...participantTwo,
  };
}

export function directConversationBindingPeer(
  row: {
    participant_one_kind: "user" | "actor";
    participant_one_workspace_member_id: string | null;
    participant_one_actor_id: string | null;
    participant_two_kind: "user" | "actor";
    participant_two_workspace_member_id: string | null;
    participant_two_actor_id: string | null;
  },
  viewer: DirectConversationIdentity,
): DirectConversationIdentity | null {
  const left =
    row.participant_one_kind === "user" &&
    row.participant_one_workspace_member_id
      ? {
          kind: "user" as const,
          workspaceMemberId: row.participant_one_workspace_member_id,
        }
      : row.participant_one_actor_id
        ? {
            kind: "actor" as const,
            actorId: row.participant_one_actor_id,
          }
        : null;
  const right =
    row.participant_two_kind === "user" &&
    row.participant_two_workspace_member_id
      ? {
          kind: "user" as const,
          workspaceMemberId: row.participant_two_workspace_member_id,
        }
      : row.participant_two_actor_id
        ? {
            kind: "actor" as const,
            actorId: row.participant_two_actor_id,
          }
        : null;

  if (!left || !right) return null;
  const viewerKey = directConversationIdentityKey(viewer);
  if (directConversationIdentityKey(left) === viewerKey) return right;
  if (directConversationIdentityKey(right) === viewerKey) return left;
  return null;
}
