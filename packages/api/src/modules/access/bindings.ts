import type { AccessGrant, CapabilityAccessTarget } from "@synapse/shared/types"
import {
  SUBJECT_KIND,
  isScopeEligibleSubject,
  remoteAgentRef,
  subjectScopeLabel,
  type ScopedSubjectTarget,
  type SubjectRef,
} from "@synapse/shared"
import type { AccessResourceType } from "./evaluator.js"

export type AccessBindableResourceType = Extract<
  AccessResourceType,
  | "installed_skill"
  | "plugin_installation"
  | "automation_event_source"
  | "actor"
  | "remote_agent"
>

export type ResourceAccessBindingStorageRow = {
  resource_type: AccessBindableResourceType
  installed_skill_id: string | null
  plugin_installation_id: string | null
  automation_event_source_id: string | null
  actor_id: string | null
  remote_agent_id: string | null
}

export type AccessBindingRelation =
  | "use_workspace"
  | "use_workspace_member"
  | "use_conversation"
  | "use_actor"
  | "use_actor_in_conversation"
  | "use_remote_agent"
  | "use_scoped"

export type AccessBindingRow = ResourceAccessBindingStorageRow & {
  id: string
  workspace_id: string
  resource_id: string
  relation: AccessBindingRelation
  subject_id: string | null
  scope_subject_id: string | null
  conversation_type_mask_override: number | null
  status: "active" | "revoked"
  source: "manual" | "default_open" | "approval" | "system"
  created_by_workspace_member_id: string | null
  reason: string | null
  created_at: string
  revoked_at: string | null
}

export function readAccessBindingResourceId(
  row: Pick<
    ResourceAccessBindingStorageRow,
    | "resource_type"
    | "installed_skill_id"
    | "plugin_installation_id"
    | "automation_event_source_id"
    | "actor_id"
    | "remote_agent_id"
  >
) {
  switch (row.resource_type) {
    case "installed_skill":
      if (!row.installed_skill_id) {
        throw new Error(
          "installed_skill_id is required for installed_skill bindings"
        )
      }
      return row.installed_skill_id
    case "plugin_installation":
      if (!row.plugin_installation_id) {
        throw new Error(
          "plugin_installation_id is required for plugin_installation bindings"
        )
      }
      return row.plugin_installation_id
    case "automation_event_source":
      if (!row.automation_event_source_id) {
        throw new Error(
          "automation_event_source_id is required for automation_event_source bindings"
        )
      }
      return row.automation_event_source_id
    case "actor":
      if (!row.actor_id) {
        throw new Error("actor_id is required for actor bindings")
      }
      return row.actor_id
    case "remote_agent":
      if (!row.remote_agent_id) {
        throw new Error("remote_agent_id is required for remote_agent bindings")
      }
      return row.remote_agent_id
    default:
      throw new Error(
        `Unsupported access binding resource type: ${String(row.resource_type)}`
      )
  }
}

export function buildResourceAccessBindingRef(input: {
  resourceType: AccessBindableResourceType
  resourceId: string
}): ResourceAccessBindingStorageRow {
  return {
    resource_type: input.resourceType,
    installed_skill_id:
      input.resourceType === "installed_skill" ? input.resourceId : null,
    plugin_installation_id:
      input.resourceType === "plugin_installation" ? input.resourceId : null,
    automation_event_source_id:
      input.resourceType === "automation_event_source"
        ? input.resourceId
        : null,
    actor_id: input.resourceType === "actor" ? input.resourceId : null,
    remote_agent_id:
      input.resourceType === "remote_agent" ? input.resourceId : null,
  }
}

/**
 * D3: derive the AccessBindingRelation from a decoded ScopedSubjectTarget.
 * Only used for display / legacy SQL-view parity — callers that need precise
 * routing should branch on `target.subject.kind` and `target.scope?.kind`.
 */
export function relationForAccessGrantTarget(
  target: AccessGrantTarget
): AccessBindingRelation {
  if (
    target.subject.kind === SUBJECT_KIND.ACTOR &&
    target.scope?.kind === SUBJECT_KIND.CONVERSATION
  ) {
    return "use_actor_in_conversation"
  }
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

export function normalizeAccessBindingRow<
  T extends ResourceAccessBindingStorageRow & {
    subject_id?: string | null
    scope_subject_id?: string | null
    subject_kind?: string | null
    subject_workspace_id_via_join?: string | null
    subject_workspace_member_id_via_join?: string | null
    subject_actor_id_via_join?: string | null
    subject_remote_agent_id_via_join?: string | null
    subject_conversation_id_via_join?: string | null
    scope_kind?: string | null
    scope_workspace_id_via_join?: string | null
    scope_conversation_id_via_join?: string | null
  },
>(row: T): T & { resource_id: string; relation: AccessBindingRelation } {
  // D3: derive a relation string from subject_kind + scope_kind (legacy
  // bookkeeping for the SQL views that still expose `relation`).
  let relation: AccessBindingRelation
  if (
    row.subject_kind === SUBJECT_KIND.ACTOR &&
    row.scope_kind === SUBJECT_KIND.CONVERSATION
  ) {
    relation = "use_actor_in_conversation"
  } else {
    switch (row.subject_kind) {
      case SUBJECT_KIND.WORKSPACE:
        relation = "use_workspace"
        break
      case SUBJECT_KIND.WORKSPACE_MEMBER:
        relation = "use_workspace_member"
        break
      case SUBJECT_KIND.CONVERSATION:
        relation = "use_conversation"
        break
      case SUBJECT_KIND.ACTOR:
        relation = "use_actor"
        break
      case SUBJECT_KIND.REMOTE_AGENT:
        relation = "use_remote_agent"
        break
      default:
        relation = "use_scoped"
    }
  }
  return {
    ...row,
    resource_id: readAccessBindingResourceId(row),
    relation,
  }
}

/**
 * D3: AccessGrantTarget is now the single `ScopedSubjectTarget` shape.
 * Consumers read `target.subject.kind` and `target.scope?.kind` directly;
 * there is no `targetType` / legacy `type` field any more.
 */
export type AccessGrantTarget = ScopedSubjectTarget

/**
 * D3: an AccessGrantTarget IS a SubjectRef-bearing object — extracting the
 * principal SubjectRef is a field read.
 */
export function accessGrantTargetToSubjectRef(
  target: AccessGrantTarget
): SubjectRef {
  return target.subject
}

/**
 * Extract the optional scope SubjectRef from a ScopedSubjectTarget. Validates
 * the scope kind so writers fail fast at the resolver boundary rather than at
 * the DB trigger.
 */
export function accessGrantTargetScopeRef(
  target: AccessGrantTarget
): SubjectRef | undefined {
  if (!target.scope) return undefined
  if (!isScopeEligibleSubject(target.scope)) {
    throw new Error(
      `scope_subject_id must be workspace | conversation, got ${target.scope.kind}`
    )
  }
  return target.scope
}

export function readAccessBindingTarget(row: {
  subject_kind?: string | null
  subject_workspace_id_via_join?: string | null
  subject_workspace_member_id_via_join?: string | null
  subject_actor_id_via_join?: string | null
  subject_remote_agent_id_via_join?: string | null
  subject_conversation_id_via_join?: string | null
  scope_kind?: string | null
  scope_workspace_id_via_join?: string | null
  scope_conversation_id_via_join?: string | null
}): AccessGrantTarget {
  const subject = subjectRefFromRow(row)
  const scope = scopeSubjectRefFromRow(row)
  return scope ? { subject, scope } : { subject }
}

function subjectRefFromRow(row: {
  subject_kind?: string | null
  subject_workspace_id_via_join?: string | null
  subject_workspace_member_id_via_join?: string | null
  subject_actor_id_via_join?: string | null
  subject_remote_agent_id_via_join?: string | null
  subject_conversation_id_via_join?: string | null
}): SubjectRef {
  switch (row.subject_kind) {
    case "workspace":
      if (!row.subject_workspace_id_via_join)
        throw new Error("workspace subject missing workspace_id")
      return {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId: row.subject_workspace_id_via_join,
      }
    case "workspace_member":
      if (!row.subject_workspace_member_id_via_join)
        throw new Error("workspace_member subject missing workspace_member_id")
      return {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId: row.subject_workspace_member_id_via_join,
      }
    case "actor":
      if (!row.subject_actor_id_via_join)
        throw new Error("actor subject missing actor_id")
      return {
        kind: SUBJECT_KIND.ACTOR,
        actorId: row.subject_actor_id_via_join,
      }
    case "remote_agent":
      if (!row.subject_remote_agent_id_via_join)
        throw new Error("remote_agent subject missing remote_agent_id")
      return remoteAgentRef(row.subject_remote_agent_id_via_join)
    case "conversation":
      if (!row.subject_conversation_id_via_join)
        throw new Error("conversation subject missing conversation_id")
      return {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: row.subject_conversation_id_via_join,
      }
    default:
      throw new Error(
        `Unsupported subject_kind for scoped-subject decode: ${String(row.subject_kind)}`
      )
  }
}

function scopeSubjectRefFromRow(row: {
  scope_kind?: string | null
  scope_workspace_id_via_join?: string | null
  scope_conversation_id_via_join?: string | null
}): SubjectRef | undefined {
  if (!row.scope_kind) return undefined
  switch (row.scope_kind) {
    case "workspace":
      if (!row.scope_workspace_id_via_join)
        throw new Error("scope workspace subject missing workspace_id")
      return {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId: row.scope_workspace_id_via_join,
      }
    case "conversation":
      if (!row.scope_conversation_id_via_join)
        throw new Error("scope conversation subject missing conversation_id")
      return {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: row.scope_conversation_id_via_join,
      }
    default:
      throw new Error(
        `Unsupported scope subject kind: ${String(row.scope_kind)}`
      )
  }
}

export function accessBindingHasTarget(
  row: Pick<AccessBindingRow, "subject_id" | "scope_subject_id"> & {
    subject_kind?: string | null
    subject_workspace_id_via_join?: string | null
    subject_workspace_member_id_via_join?: string | null
    subject_actor_id_via_join?: string | null
    subject_remote_agent_id_via_join?: string | null
    subject_conversation_id_via_join?: string | null
    scope_kind?: string | null
    scope_workspace_id_via_join?: string | null
    scope_conversation_id_via_join?: string | null
  },
  target: AccessGrantTarget
) {
  let rowTarget: AccessGrantTarget
  try {
    rowTarget = readAccessBindingTarget(row)
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
    case SUBJECT_KIND.EXTERNAL:
      return (
        a.externalIdentityKey ===
        (b as Extract<SubjectRef, { kind: typeof SUBJECT_KIND.EXTERNAL }>)
          .externalIdentityKey
      )
    case SUBJECT_KIND.SYSTEM:
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

export function mapAccessBindingToGrant(
  row: AccessBindingRow & {
    subject_kind?: string | null
    subject_workspace_id_via_join?: string | null
    subject_workspace_member_id_via_join?: string | null
    subject_actor_id_via_join?: string | null
    subject_remote_agent_id_via_join?: string | null
    subject_conversation_id_via_join?: string | null
    scope_kind?: string | null
    scope_workspace_id_via_join?: string | null
    scope_conversation_id_via_join?: string | null
  },
  fallbackReason?: string,
  options?: {
    effectiveConversationTypeMask?: number
  }
): AccessGrant {
  const target = readAccessBindingTarget(row)
  const capabilityTarget: CapabilityAccessTarget = target.scope
    ? { subject: target.subject, scope: target.scope }
    : { subject: target.subject }

  return {
    id: row.id,
    resourceId: row.resource_id,
    workspaceId: row.workspace_id || "",
    target: capabilityTarget,
    status: row.status,
    grantedByWorkspaceMemberId: row.created_by_workspace_member_id || undefined,
    reason: row.reason || fallbackReason,
    conversationTypeMaskOverride: row.conversation_type_mask_override ?? null,
    effectiveConversationTypeMask: options?.effectiveConversationTypeMask,
    createdAt: row.created_at,
    revokedAt: row.revoked_at || undefined,
  }
}

// Re-export the helper for callers that want the legacy display label.
export { subjectScopeLabel }
