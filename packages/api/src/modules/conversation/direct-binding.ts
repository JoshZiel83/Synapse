export type DirectConversationIdentity =
  | {
      kind: "user";
      workspaceId: string;
      userId: string;
    }
  | {
      kind: "actor";
      actorId: string;
    };

export function directConversationIdentityKey(
  identity: DirectConversationIdentity,
) {
  return identity.kind === "user"
    ? `user:${identity.workspaceId}:${identity.userId}`
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
          participant_one_workspace_id: pair.participantOne.workspaceId,
          participant_one_user_id: pair.participantOne.userId,
          participant_one_actor_id: null,
        }
      : {
          participant_one_kind: "actor" as const,
          participant_one_workspace_id: null,
          participant_one_user_id: null,
          participant_one_actor_id: pair.participantOne.actorId,
        };
  const participantTwo =
    pair.participantTwo.kind === "user"
      ? {
          participant_two_kind: "user" as const,
          participant_two_workspace_id: pair.participantTwo.workspaceId,
          participant_two_user_id: pair.participantTwo.userId,
          participant_two_actor_id: null,
        }
      : {
          participant_two_kind: "actor" as const,
          participant_two_workspace_id: null,
          participant_two_user_id: null,
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
    participant_one_workspace_id: string | null;
    participant_one_user_id: string | null;
    participant_one_actor_id: string | null;
    participant_two_kind: "user" | "actor";
    participant_two_workspace_id: string | null;
    participant_two_user_id: string | null;
    participant_two_actor_id: string | null;
  },
  viewer: DirectConversationIdentity,
): DirectConversationIdentity | null {
  const left =
    row.participant_one_kind === "user" &&
    row.participant_one_workspace_id &&
    row.participant_one_user_id
      ? {
          kind: "user" as const,
          workspaceId: row.participant_one_workspace_id,
          userId: row.participant_one_user_id,
        }
      : row.participant_one_actor_id
        ? {
            kind: "actor" as const,
            actorId: row.participant_one_actor_id,
          }
        : null;
  const right =
    row.participant_two_kind === "user" &&
    row.participant_two_workspace_id &&
    row.participant_two_user_id
      ? {
          kind: "user" as const,
          workspaceId: row.participant_two_workspace_id,
          userId: row.participant_two_user_id,
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

