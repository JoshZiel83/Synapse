import type { CapabilityAccessTarget } from "@synapse/shared/types"
import {
  SUBJECT_KIND,
  isScopeEligibleSubject,
  remoteAgentRef,
  subjectScopeLabel,
  type ScopedSubjectTarget,
  type SubjectRef,
} from "@synapse/shared"

export type AutomationEventSourceBindingResourceType = "automation_event_source"

export type AutomationEventSourceBindingStorageRow = {
  resourceType: AutomationEventSourceBindingResourceType
  automationEventSourceId: string | null
}

export type AutomationEventSourceBindingRelation =
  | "use_workspace"
  | "use_workspace_member"
  | "use_conversation"
  | "use_actor"
  | "use_remote_agent"
  | "use_scoped"

export type AutomationEventSourceBindingRow =
  AutomationEventSourceBindingStorageRow & {
    id: string
    workspaceId: string
    resourceId: string
    relation: AutomationEventSourceBindingRelation
    subjectId: string | null
    scopeSubjectId: string | null
    conversationTypeMaskOverride: number | null
    status: "active" | "revoked"
    source: "manual" | "default_open" | "approval" | "system"
    createdByWorkspaceMemberId: string | null
    reason: string | null
    createdAt: Date
    revokedAt: Date | null
  }

export type AutomationEventSourceBindingJoinedRow =
  AutomationEventSourceBindingRow & {
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

export function readAutomationEventSourceAccessBindingResourceId(
  row: Pick<
    AutomationEventSourceBindingStorageRow,
    "resourceType" | "automationEventSourceId"
  >
) {
  if (!row.automationEventSourceId) {
    throw new Error(
      "automation_event_source_id is required for automation event source bindings"
    )
  }
  return row.automationEventSourceId
}

export function buildAutomationEventSourceAccessBindingRef(input: {
  resourceType: AutomationEventSourceBindingResourceType
  resourceId: string
}): AutomationEventSourceBindingStorageRow {
  return {
    resourceType: input.resourceType,
    automationEventSourceId: input.resourceId,
  }
}

/**
 * D3: derive the AutomationEventSourceBindingRelation from a decoded ScopedSubjectTarget.
 * Only used for display / legacy SQL-view parity — callers that need precise
 * routing should branch on `target.subject.kind` and `target.scope?.kind`.
 */
export function relationForAutomationEventSourceAccessBindingTarget(
  target: AutomationEventSourceBindingTarget
): AutomationEventSourceBindingRelation {
  switch (target.subject.kind) {
    case SUBJECT_KIND.WORKSPACE:
      return "use_workspace"
    case SUBJECT_KIND.WORKSPACE_MEMBER:
      return "use_workspace_member"
    case SUBJECT_KIND.CONVERSATION:
      return "use_conversation"
    case SUBJECT_KIND.ACTOR:
      return "use_actor"
    case SUBJECT_KIND.REMOTE_AGENT:
      return "use_remote_agent"
    default:
      return "use_scoped"
  }
}

// `normalizeAutomationEventSourceAccessBindingRow` performs row normalization
// (derives relation + resourceId from a DB row), so it lives in the access
// data-access layer (`repo.ts`) per guard-layering r4/r7. Re-exported here so
// existing importers of `./bindings.js` keep working unchanged.
export { normalizeAutomationEventSourceAccessBindingRow } from "./repo.js"

/**
 * D3: AutomationEventSourceBindingTarget is now the single `ScopedSubjectTarget` shape.
 * Consumers read `target.subject.kind` and `target.scope?.kind` directly;
 * there is no `targetType` / legacy `type` field any more.
 */
export type AutomationEventSourceBindingTarget = ScopedSubjectTarget

/**
 * D3: an AutomationEventSourceBindingTarget IS a SubjectRef-bearing object — extracting the
 * principal SubjectRef is a field read.
 */
export function accessGrantTargetToSubjectRef(
  target: AutomationEventSourceBindingTarget
): SubjectRef {
  return target.subject
}

/**
 * Extract the optional scope SubjectRef from a ScopedSubjectTarget. Validates
 * the scope kind so writers fail fast at the resolver boundary rather than at
 * the DB trigger.
 */
export function accessGrantTargetScopeRef(
  target: AutomationEventSourceBindingTarget
): SubjectRef | undefined {
  if (!target.scope) return undefined
  if (!isScopeEligibleSubject(target.scope)) {
    throw new Error(
      `scope_subject_id must be workspace | conversation, got ${target.scope.kind}`
    )
  }
  return target.scope
}

export function readAutomationEventSourceAccessBindingTarget(row: {
  subjectKind?: string | null
  subjectWorkspaceIdViaJoin?: string | null
  subjectWorkspaceMemberIdViaJoin?: string | null
  subjectActorIdViaJoin?: string | null
  subjectRemoteAgentIdViaJoin?: string | null
  subjectConversationIdViaJoin?: string | null
  scopeKind?: string | null
  scopeWorkspaceIdViaJoin?: string | null
  scopeConversationIdViaJoin?: string | null
}): AutomationEventSourceBindingTarget {
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

export function automationEventSourceAccessBindingHasTarget(
  row: Pick<AutomationEventSourceBindingRow, "subjectId" | "scopeSubjectId"> & {
    subjectKind?: string | null
    subjectWorkspaceIdViaJoin?: string | null
    subjectWorkspaceMemberIdViaJoin?: string | null
    subjectActorIdViaJoin?: string | null
    subjectRemoteAgentIdViaJoin?: string | null
    subjectConversationIdViaJoin?: string | null
    scopeKind?: string | null
    scopeWorkspaceIdViaJoin?: string | null
    scopeConversationIdViaJoin?: string | null
  },
  target: AutomationEventSourceBindingTarget
) {
  let rowTarget: AutomationEventSourceBindingTarget
  try {
    rowTarget = readAutomationEventSourceAccessBindingTarget(row)
  } catch {
    return false
  }
  return (
    subjectRefEqual(rowTarget.subject, target.subject) &&
    ((rowTarget.scope == null && target.scope == null) ||
      (rowTarget.scope != null &&
        target.scope != null &&
        subjectRefEqual(rowTarget.scope, target.scope)))
  )
}

function subjectRefEqual(a: SubjectRef, b: SubjectRef): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case SUBJECT_KIND.WORKSPACE:
      return (
        a.workspaceId ===
        (b as Extract<SubjectRef, { kind: typeof SUBJECT_KIND.WORKSPACE }>)
          .workspaceId
      )
    case SUBJECT_KIND.WORKSPACE_MEMBER:
      return (
        a.memberId ===
        (
          b as Extract<
            SubjectRef,
            { kind: typeof SUBJECT_KIND.WORKSPACE_MEMBER }
          >
        ).memberId
      )
    case SUBJECT_KIND.ACTOR:
      return (
        a.actorId ===
        (b as Extract<SubjectRef, { kind: typeof SUBJECT_KIND.ACTOR }>).actorId
      )
    case SUBJECT_KIND.REMOTE_AGENT:
      return (
        a.remoteAgentId ===
        (b as Extract<SubjectRef, { kind: typeof SUBJECT_KIND.REMOTE_AGENT }>)
          .remoteAgentId
      )
    case SUBJECT_KIND.CONVERSATION:
      return (
        a.conversationId ===
        (b as Extract<SubjectRef, { kind: typeof SUBJECT_KIND.CONVERSATION }>)
          .conversationId
      )
    case SUBJECT_KIND.USER:
      return (
        a.userId ===
        (b as Extract<SubjectRef, { kind: typeof SUBJECT_KIND.USER }>).userId
      )
    case SUBJECT_KIND.EXTERNAL: {
      const bb = b as Extract<
        SubjectRef,
        { kind: typeof SUBJECT_KIND.EXTERNAL }
      >
      return (
        a.workspaceId === bb.workspaceId &&
        a.transportAddressId === bb.transportAddressId
      )
    }
    case SUBJECT_KIND.PLATFORM:
      return true
  }
}

/**
 * D3: matcher used by callers that have a decoded `CapabilityAccessTarget`
 * (always `{subject, scope?}`) and need to check whether it covers the current
 * runtime (workspace, conversation, actor, workspace_member, remote_agent)
 * context.
 */
export function capabilityTargetMatchesContext(
  target: CapabilityAccessTarget,
  context: {
    grantOwnerWorkspaceId: string
    contextWorkspaceId: string
    actorId?: string | null
    conversationId?: string | null
    workspaceMemberId?: string | null
    remoteAgentId?: string | null
  }
): boolean {
  if (!subjectInContext(target.subject, context)) return false
  if (!target.scope) return true
  return scopeInContext(target.scope, context)
}

function subjectInContext(
  subject: SubjectRef,
  context: {
    grantOwnerWorkspaceId: string
    contextWorkspaceId: string
    actorId?: string | null
    conversationId?: string | null
    workspaceMemberId?: string | null
    remoteAgentId?: string | null
  }
): boolean {
  switch (subject.kind) {
    case SUBJECT_KIND.WORKSPACE:
      return context.contextWorkspaceId === context.grantOwnerWorkspaceId
    case SUBJECT_KIND.WORKSPACE_MEMBER:
      return (
        !!context.workspaceMemberId &&
        subject.memberId === context.workspaceMemberId
      )
    case SUBJECT_KIND.ACTOR:
      return !!context.actorId && subject.actorId === context.actorId
    case SUBJECT_KIND.REMOTE_AGENT:
      return (
        !!context.remoteAgentId &&
        subject.remoteAgentId === context.remoteAgentId
      )
    case SUBJECT_KIND.CONVERSATION:
      return (
        !!context.conversationId &&
        subject.conversationId === context.conversationId
      )
    default:
      return false
  }
}

function scopeInContext(
  scope: SubjectRef,
  context: {
    contextWorkspaceId: string
    grantOwnerWorkspaceId: string
    conversationId?: string | null
  }
): boolean {
  switch (scope.kind) {
    case SUBJECT_KIND.WORKSPACE:
      return scope.workspaceId === context.contextWorkspaceId
    case SUBJECT_KIND.CONVERSATION:
      return (
        !!context.conversationId &&
        scope.conversationId === context.conversationId
      )
    default:
      return false
  }
}

// mapAutomationEventSourceAccessBindingToGrant moved to ./presenter.ts (it does
// Date→ISO serialization, which guard-layering r3 confines to presenter*.ts).
// Re-exported so existing `./bindings.js` importers are unchanged. round-6 P1-7.
export { mapAutomationEventSourceAccessBindingToGrant } from "./presenter.js"

// Re-export the helper for callers that want the legacy display label.
export { subjectScopeLabel }
