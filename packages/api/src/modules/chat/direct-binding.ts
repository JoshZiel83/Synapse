import {
  CONVERSATION_PARTICIPANT_TYPE,
  SUBJECT_KIND,
  type SubjectRef,
} from "@synapse/shared"
import type { KyselyDb } from "../../infrastructure/database/kysely.js"
import {
  loadAccessSubject,
  upsertAccessSubject,
} from "../access/subject-registry.js"

const PT = CONVERSATION_PARTICIPANT_TYPE

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

function directIdentityToSubjectRef(
  identity: DirectConversationIdentity
): SubjectRef {
  switch (identity.kind) {
    case PT.WORKSPACE_MEMBER:
      return {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId: identity.workspaceMemberId,
      }
    case PT.ACTOR:
      return { kind: SUBJECT_KIND.ACTOR, actorId: identity.actorId }
    case PT.REMOTE_AGENT:
      return {
        kind: SUBJECT_KIND.REMOTE_AGENT,
        remoteAgentId: identity.remoteAgentId,
      }
  }
}

function subjectRefToDirectIdentity(
  ref: SubjectRef
): DirectConversationIdentity | null {
  switch (ref.kind) {
    case SUBJECT_KIND.WORKSPACE_MEMBER:
      return { kind: PT.WORKSPACE_MEMBER, workspaceMemberId: ref.memberId }
    case SUBJECT_KIND.ACTOR:
      return { kind: PT.ACTOR, actorId: ref.actorId }
    case SUBJECT_KIND.REMOTE_AGENT:
      return { kind: PT.REMOTE_AGENT, remoteAgentId: ref.remoteAgentId }
    default:
      return null
  }
}

/**
 * P1b: returns the column shape for inserting a row into
 * `direct_conversation_bindings`. The two polymorphic participant_*_type +
 * three nullable FKs are collapsed into a single `*_subject_id` per side.
 * Caller is responsible for ensuring the subject upserts happen inside the
 * same transaction as the binding insert.
 */
export async function directConversationBindingValues(
  db: KyselyDb,
  pair: ReturnType<typeof canonicalizeDirectConversationPair>
) {
  const participantOneSubjectId = await upsertAccessSubject(
    db,
    directIdentityToSubjectRef(pair.participantOne)
  )
  const participantTwoSubjectId = await upsertAccessSubject(
    db,
    directIdentityToSubjectRef(pair.participantTwo)
  )
  return {
    participant_one_subject_id: participantOneSubjectId,
    participant_two_subject_id: participantTwoSubjectId,
  }
}

/**
 * Given a stored binding row and the viewer's identity, returns the peer
 * identity. Requires the row to JOIN access_subjects so the participant
 * subject ids resolve to their kind+id.
 */
export async function directConversationBindingPeer(
  db: KyselyDb,
  row: {
    participant_one_subject_id: string
    participant_two_subject_id: string
  },
  viewer: DirectConversationIdentity
): Promise<DirectConversationIdentity | null> {
  const [oneRef, twoRef] = await Promise.all([
    loadAccessSubject(db, row.participant_one_subject_id),
    loadAccessSubject(db, row.participant_two_subject_id),
  ])
  const left = oneRef ? subjectRefToDirectIdentity(oneRef) : null
  const right = twoRef ? subjectRefToDirectIdentity(twoRef) : null
  if (!left || !right) return null
  const viewerKey = directConversationIdentityKey(viewer)
  if (directConversationIdentityKey(left) === viewerKey) return right
  if (directConversationIdentityKey(right) === viewerKey) return left
  return null
}
