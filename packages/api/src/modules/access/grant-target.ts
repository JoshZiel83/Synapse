import {
  SUBJECT_KIND,
  remoteAgentRef,
  type ScopedSubjectTarget,
  type SubjectRef,
} from "@synapse/shared"

export type AutomationEventSourceGrantRow = {
  id: string
  workspaceId: string
  resourceId: string
  conversationTypeMaskOverride: number | null
  status: "active" | "revoked"
  createdByWorkspaceMemberId: string | null
  reason: string | null
  createdAt: Date
  revokedAt: Date | null
}

export type AutomationEventSourceGrantJoinedRow =
  AutomationEventSourceGrantRow & {
    subjectKind?: string | null
    subjectWorkspaceIdViaJoin?: string | null
    subjectWorkspaceMemberIdViaJoin?: string | null
    subjectActorIdViaJoin?: string | null
    subjectRemoteAgentIdViaJoin?: string | null
    subjectConversationIdViaJoin?: string | null
    scopeKind?: string | null
    scopeWorkspaceIdViaJoin?: string | null
    scopeConversationIdViaJoin?: string | null
  }

/**
 * D3: AutomationEventSourceGrantTarget is now the single `ScopedSubjectTarget` shape.
 * Consumers read `target.subject.kind` and `target.scope?.kind` directly;
 * there is no `targetType` / legacy `type` field any more.
 */
export type AutomationEventSourceGrantTarget = ScopedSubjectTarget

export function readAutomationEventSourceAccessGrantTarget(row: {
  subjectKind?: string | null
  subjectWorkspaceIdViaJoin?: string | null
  subjectWorkspaceMemberIdViaJoin?: string | null
  subjectActorIdViaJoin?: string | null
  subjectRemoteAgentIdViaJoin?: string | null
  subjectConversationIdViaJoin?: string | null
  scopeKind?: string | null
  scopeWorkspaceIdViaJoin?: string | null
  scopeConversationIdViaJoin?: string | null
}): AutomationEventSourceGrantTarget {
  const subject = subjectRefFromRow(row)
  const scope = scopeSubjectRefFromRow(row)
  return scope ? { subject, scope } : { subject }
}

function subjectRefFromRow(row: {
  subjectKind?: string | null
  subjectWorkspaceIdViaJoin?: string | null
  subjectWorkspaceMemberIdViaJoin?: string | null
  subjectActorIdViaJoin?: string | null
  subjectRemoteAgentIdViaJoin?: string | null
  subjectConversationIdViaJoin?: string | null
}): SubjectRef {
  switch (row.subjectKind) {
    case "workspace":
      if (!row.subjectWorkspaceIdViaJoin)
        throw new Error("workspace subject missing workspace_id")
      return {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId: row.subjectWorkspaceIdViaJoin,
      }
    case "workspace_member":
      if (!row.subjectWorkspaceMemberIdViaJoin)
        throw new Error("workspace_member subject missing workspace_member_id")
      return {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId: row.subjectWorkspaceMemberIdViaJoin,
      }
    case "actor":
      if (!row.subjectActorIdViaJoin)
        throw new Error("actor subject missing actor_id")
      return {
        kind: SUBJECT_KIND.ACTOR,
        actorId: row.subjectActorIdViaJoin,
      }
    case "remote_agent":
      if (!row.subjectRemoteAgentIdViaJoin)
        throw new Error("remote_agent subject missing remote_agent_id")
      return remoteAgentRef(row.subjectRemoteAgentIdViaJoin)
    case "conversation":
      if (!row.subjectConversationIdViaJoin)
        throw new Error("conversation subject missing conversation_id")
      return {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: row.subjectConversationIdViaJoin,
      }
    default:
      throw new Error(
        `Unsupported subject_kind for scoped-subject decode: ${String(row.subjectKind)}`
      )
  }
}

function scopeSubjectRefFromRow(row: {
  scopeKind?: string | null
  scopeWorkspaceIdViaJoin?: string | null
  scopeConversationIdViaJoin?: string | null
}): SubjectRef | undefined {
  if (!row.scopeKind) return undefined
  switch (row.scopeKind) {
    case "workspace":
      if (!row.scopeWorkspaceIdViaJoin)
        throw new Error("scope workspace subject missing workspace_id")
      return {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId: row.scopeWorkspaceIdViaJoin,
      }
    case "conversation":
      if (!row.scopeConversationIdViaJoin)
        throw new Error("scope conversation subject missing conversation_id")
      return {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: row.scopeConversationIdViaJoin,
      }
    default:
      throw new Error(
        `Unsupported scope subject kind: ${String(row.scopeKind)}`
      )
  }
}
