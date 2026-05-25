import type { AccessGrant, CapabilityAccessTarget } from "@synapse/shared/types"
import { SUBJECT_KIND, type SubjectRef } from "@synapse/shared"
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

export type AccessBindingTargetType =
  | "workspace"
  | "workspace_member"
  | "conversation"
  | "actor"
  | "actor_in_conversation"

export type AccessBindingRelation =
  | "use_workspace"
  | "use_workspace_member"
  | "use_conversation"
  | "use_actor"
  | "use_actor_in_conversation"

export type AccessBindingRow = ResourceAccessBindingStorageRow & {
  id: string
  workspace_id: string
  resource_id: string
  target_type: AccessBindingTargetType
  relation: AccessBindingRelation
  // P1b: new canonical reference. Nullable transitionally — non-null after the
  // double-write rollout is fully deployed. The legacy subject_*_id columns
  // are still authoritative for reads until P7 contracts them away.
  subject_id: string | null
  subject_workspace_id: string | null
  subject_workspace_member_id: string | null
  subject_actor_id: string | null
  subject_conversation_id: string | null
  subject_conversation_actor_context_id: string | null
  conversation_type_mask_override: number | null
  status: "active" | "revoked"
  source: "manual" | "default_open" | "relay_auto" | "approval" | "system"
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

export function relationForAccessTargetType(
  targetType: AccessBindingTargetType
): AccessBindingRelation {
  switch (targetType) {
    case "workspace":
      return "use_workspace"
    case "workspace_member":
      return "use_workspace_member"
    case "conversation":
      return "use_conversation"
    case "actor":
      return "use_actor"
    case "actor_in_conversation":
      return "use_actor_in_conversation"
    default:
      throw new Error(
        `Unsupported access binding target type: ${String(targetType)}`
      )
  }
}

export function normalizeAccessBindingRow<
  T extends ResourceAccessBindingStorageRow & {
    target_type: AccessBindingTargetType
  },
>(row: T): T & { resource_id: string; relation: AccessBindingRelation } {
  return {
    ...row,
    resource_id: readAccessBindingResourceId(row),
    relation: relationForAccessTargetType(row.target_type),
  }
}

export type AccessGrantTarget =
  | {
      targetType: "workspace"
      subjectWorkspaceId: string
      subjectWorkspaceMemberId: null
      subjectActorId: null
      subjectConversationId: null
      subjectConversationActorContextId: null
    }
  | {
      targetType: "workspace_member"
      subjectWorkspaceId: null
      subjectWorkspaceMemberId: string
      subjectActorId: null
      subjectConversationId: null
      subjectConversationActorContextId: null
    }
  | {
      targetType: "conversation"
      subjectWorkspaceId: null
      subjectWorkspaceMemberId: null
      subjectActorId: null
      subjectConversationId: string
      subjectConversationActorContextId: null
    }
  | {
      targetType: "actor"
      subjectWorkspaceId: null
      subjectWorkspaceMemberId: null
      subjectActorId: string
      subjectConversationId: null
      subjectConversationActorContextId: null
    }
  | {
      targetType: "actor_in_conversation"
      subjectWorkspaceId: null
      subjectWorkspaceMemberId: null
      subjectActorId: string
      subjectConversationId: string
      subjectConversationActorContextId: string
    }

/**
 * P1b bridge: translate an application-layer AccessGrantTarget into the
 * canonical SubjectRef used by access_subjects. Pass the resulting ref to
 * `upsertAccessSubject` (from subject-registry.ts) to obtain a subject_id.
 */
export function accessGrantTargetToSubjectRef(
  target: AccessGrantTarget
): SubjectRef {
  switch (target.targetType) {
    case "workspace":
      return {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId: target.subjectWorkspaceId,
      }
    case "workspace_member":
      return {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId: target.subjectWorkspaceMemberId,
      }
    case "conversation":
      return {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: target.subjectConversationId,
      }
    case "actor":
      return { kind: SUBJECT_KIND.ACTOR, actorId: target.subjectActorId }
    case "actor_in_conversation":
      return {
        kind: SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT,
        contextId: target.subjectConversationActorContextId,
      }
  }
}

function requireResolvedSubjectId(
  value: string | null,
  fieldName: string,
  targetType: AccessBindingTargetType
) {
  if (value) {
    return value
  }
  throw new Error(
    `${fieldName} is required for resolved ${targetType} access bindings`
  )
}

export function readAccessBindingTarget(
  row: Pick<
    AccessBindingRow,
    | "target_type"
    | "subject_workspace_id"
    | "subject_workspace_member_id"
    | "subject_actor_id"
    | "subject_conversation_id"
    | "subject_conversation_actor_context_id"
    | "conversation_type_mask_override"
  >
): AccessGrantTarget {
  switch (row.target_type) {
    case "workspace":
      return {
        targetType: "workspace",
        subjectWorkspaceId: requireResolvedSubjectId(
          row.subject_workspace_id,
          "subject_workspace_id",
          row.target_type
        ),
        subjectWorkspaceMemberId: null,
        subjectActorId: null,
        subjectConversationId: null,
        subjectConversationActorContextId: null,
      }
    case "workspace_member":
      return {
        targetType: "workspace_member",
        subjectWorkspaceId: null,
        subjectWorkspaceMemberId: requireResolvedSubjectId(
          row.subject_workspace_member_id,
          "subject_workspace_member_id",
          row.target_type
        ),
        subjectActorId: null,
        subjectConversationId: null,
        subjectConversationActorContextId: null,
      }
    case "conversation":
      return {
        targetType: "conversation",
        subjectWorkspaceId: null,
        subjectWorkspaceMemberId: null,
        subjectActorId: null,
        subjectConversationId: requireResolvedSubjectId(
          row.subject_conversation_id,
          "subject_conversation_id",
          row.target_type
        ),
        subjectConversationActorContextId: null,
      }
    case "actor":
      return {
        targetType: "actor",
        subjectWorkspaceId: null,
        subjectWorkspaceMemberId: null,
        subjectActorId: requireResolvedSubjectId(
          row.subject_actor_id,
          "subject_actor_id",
          row.target_type
        ),
        subjectConversationId: null,
        subjectConversationActorContextId: null,
      }
    case "actor_in_conversation":
      return {
        targetType: "actor_in_conversation",
        subjectWorkspaceId: null,
        subjectWorkspaceMemberId: null,
        subjectActorId: requireResolvedSubjectId(
          row.subject_actor_id,
          "subject_actor_id",
          row.target_type
        ),
        subjectConversationId: requireResolvedSubjectId(
          row.subject_conversation_id,
          "subject_conversation_id",
          row.target_type
        ),
        subjectConversationActorContextId: requireResolvedSubjectId(
          row.subject_conversation_actor_context_id,
          "subject_conversation_actor_context_id",
          row.target_type
        ),
      }
    default:
      throw new Error(
        `Unsupported stored access target type: ${String(row.target_type)}`
      )
  }
}

export function accessBindingHasTarget(
  row: Pick<
    AccessBindingRow,
    | "target_type"
    | "subject_workspace_id"
    | "subject_workspace_member_id"
    | "subject_actor_id"
    | "subject_conversation_id"
    | "subject_conversation_actor_context_id"
  >,
  target: AccessGrantTarget
) {
  switch (target.targetType) {
    case "workspace":
      return (
        row.target_type === "workspace" &&
        (row.subject_workspace_id || null) === target.subjectWorkspaceId
      )
    case "workspace_member":
      return (
        row.target_type === "workspace_member" &&
        (row.subject_workspace_member_id || null) ===
          target.subjectWorkspaceMemberId
      )
    case "conversation":
      return (
        row.target_type === "conversation" &&
        (row.subject_conversation_id || null) === target.subjectConversationId
      )
    case "actor":
      return (
        row.target_type === "actor" &&
        (row.subject_actor_id || null) === target.subjectActorId
      )
    case "actor_in_conversation":
      return (
        row.target_type === "actor_in_conversation" &&
        (row.subject_conversation_actor_context_id || null) ===
          target.subjectConversationActorContextId
      )
    default:
      return false
  }
}

/**
 * Shared matcher used by callers that have a decoded
 * `CapabilityAccessTarget` (as returned by `mapAccessBindingToGrant`) and need
 * to check whether it covers the current (workspace, conversation, actor,
 * workspace_member) context.
 *
 * Workspace-scoped targets are implicit — the grant is bound to the workspace
 * row holding it. Pass `grantOwnerWorkspaceId` (the workspace the grant lives
 * in) plus `contextWorkspaceId` (the runtime context's workspace) to disambiguate.
 *
 * Returns true when the grant's target shape matches the runtime context for
 * its target type:
 *   - workspace                : context workspace == grant's owning workspace
 *   - workspace_member         : workspace_member-id matches
 *   - conversation             : conversation-id matches
 *   - actor                    : actor-id matches
 *   - actor_in_conversation    : actor-id AND conversation-id both match
 */
export function capabilityTargetMatchesContext(
  target: CapabilityAccessTarget,
  context: {
    grantOwnerWorkspaceId: string
    contextWorkspaceId: string
    actorId?: string | null
    conversationId?: string | null
    workspaceMemberId?: string | null
  }
): boolean {
  switch (target.type) {
    case "workspace":
      return context.contextWorkspaceId === context.grantOwnerWorkspaceId
    case "workspace_member":
      return (
        !!context.workspaceMemberId &&
        target.workspaceMemberId === context.workspaceMemberId
      )
    case "conversation":
      return (
        !!context.conversationId &&
        target.conversationId === context.conversationId
      )
    case "actor":
      return !!context.actorId && target.actorId === context.actorId
    case "actor_in_conversation":
      return (
        !!context.actorId &&
        !!context.conversationId &&
        target.actorId === context.actorId &&
        target.conversationId === context.conversationId
      )
    default:
      return false
  }
}

export function mapAccessBindingToGrant(
  row: AccessBindingRow,
  fallbackReason?: string,
  options?: {
    effectiveConversationTypeMask?: number
  }
): AccessGrant {
  const target = readAccessBindingTarget(row)
  let capabilityTarget: CapabilityAccessTarget

  switch (target.targetType) {
    case "workspace":
      capabilityTarget = { type: "workspace" }
      break
    case "workspace_member":
      capabilityTarget = {
        type: "workspace_member",
        workspaceMemberId: target.subjectWorkspaceMemberId || undefined,
      }
      break
    case "conversation":
      capabilityTarget = {
        type: "conversation",
        conversationId: target.subjectConversationId || undefined,
      }
      break
    case "actor":
      capabilityTarget = {
        type: "actor",
        actorId: target.subjectActorId || undefined,
      }
      break
    case "actor_in_conversation":
      capabilityTarget = {
        type: "actor_in_conversation",
        actorId: target.subjectActorId || undefined,
        conversationId: target.subjectConversationId || undefined,
      }
      break
  }

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
