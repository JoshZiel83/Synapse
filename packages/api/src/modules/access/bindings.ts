import type {
  AccessGrant,
  AccessTarget,
  CapabilityAccessTarget,
} from "@synapse/shared/types"
import type { AccessResourceType } from "./core.js"
import { ensureConversationActorContext } from "../session/service.js"

export type AccessBindableResourceType = Extract<
  AccessResourceType,
  | "installed_skill"
  | "plugin_installation"
  | "relay_capability"
  | "automation_event_source"
>

export type ResourceAccessBindingStorageRow = {
  resource_type: AccessBindableResourceType
  installed_skill_id: string | null
  plugin_installation_id: string | null
  relay_capability_id: string | null
  automation_event_source_id: string | null
}

export type AccessBindingTargetType =
  | "workspace"
  | "conversation"
  | "actor"
  | "actor_in_conversation"

export type AccessBindingRelation =
  | "use_workspace"
  | "use_conversation"
  | "use_actor"
  | "use_actor_in_conversation"

export type AccessBindingRow = ResourceAccessBindingStorageRow & {
  id: string
  workspace_id: string
  resource_id: string
  target_type: AccessBindingTargetType
  relation: AccessBindingRelation
  subject_workspace_id: string | null
  subject_actor_id: string | null
  subject_conversation_id: string | null
  subject_conversation_actor_context_id: string | null
  conversation_type_mask_override: number | null
  status: "active" | "revoked"
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
    | "relay_capability_id"
    | "automation_event_source_id"
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
    case "relay_capability":
      if (!row.relay_capability_id) {
        throw new Error(
          "relay_capability_id is required for relay_capability bindings"
        )
      }
      return row.relay_capability_id
    case "automation_event_source":
      if (!row.automation_event_source_id) {
        throw new Error(
          "automation_event_source_id is required for automation_event_source bindings"
        )
      }
      return row.automation_event_source_id
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
    relay_capability_id:
      input.resourceType === "relay_capability" ? input.resourceId : null,
    automation_event_source_id:
      input.resourceType === "automation_event_source"
        ? input.resourceId
        : null,
  }
}

export function relationForAccessTargetType(
  targetType: AccessBindingTargetType
): AccessBindingRelation {
  switch (targetType) {
    case "workspace":
      return "use_workspace"
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
      subjectActorId: null
      subjectConversationId: null
      subjectConversationActorContextId: null
    }
  | {
      targetType: "conversation"
      subjectWorkspaceId: null
      subjectActorId: null
      subjectConversationId: string
      subjectConversationActorContextId: null
    }
  | {
      targetType: "actor"
      subjectWorkspaceId: null
      subjectActorId: string
      subjectConversationId: null
      subjectConversationActorContextId: null
    }
  | {
      targetType: "actor_in_conversation"
      subjectWorkspaceId: null
      subjectActorId: string
      subjectConversationId: string
      subjectConversationActorContextId: string
    }

export async function resolveAccessGrantTarget(input: {
  workspaceId: string
  target: AccessTarget
}): Promise<AccessGrantTarget> {
  switch (input.target.type) {
    case "workspace":
      return {
        targetType: "workspace",
        subjectWorkspaceId: input.workspaceId,
        subjectActorId: null,
        subjectConversationId: null,
        subjectConversationActorContextId: null,
      }
    case "conversation":
      if (!input.target.conversationId) {
        throw new Error("conversationId is required for conversation target")
      }
      return {
        targetType: "conversation",
        subjectWorkspaceId: null,
        subjectActorId: null,
        subjectConversationId: input.target.conversationId,
        subjectConversationActorContextId: null,
      }
    case "actor":
      if (!input.target.actorId) {
        throw new Error("actorId is required for actor target")
      }
      return {
        targetType: "actor",
        subjectWorkspaceId: null,
        subjectActorId: input.target.actorId,
        subjectConversationId: null,
        subjectConversationActorContextId: null,
      }
    case "actor_in_conversation": {
      if (!input.target.actorId || !input.target.conversationId) {
        throw new Error(
          "actorId and conversationId are required for actor_in_conversation target"
        )
      }
      const context = await ensureConversationActorContext({
        actorId: input.target.actorId,
        conversationId: input.target.conversationId,
      })
      return {
        targetType: "actor_in_conversation",
        subjectWorkspaceId: null,
        subjectActorId: input.target.actorId,
        subjectConversationId: input.target.conversationId,
        subjectConversationActorContextId: context.conversationActorContextId,
      }
    }
    default:
      throw new Error(
        `Unsupported access target type: ${String(input.target.type)}`
      )
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
        subjectActorId: null,
        subjectConversationId: null,
        subjectConversationActorContextId: null,
      }
    case "conversation":
      return {
        targetType: "conversation",
        subjectWorkspaceId: null,
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

export function mapAccessBindingToGrant(
  row: AccessBindingRow,
  permissionsOrFallbackReason?: string[] | string,
  fallbackReasonOrOptions?:
    | string
    | {
        effectiveConversationTypeMask?: number
      },
  options?: {
    effectiveConversationTypeMask?: number
  }
): AccessGrant {
  const fallbackReason =
    typeof permissionsOrFallbackReason === "string"
      ? permissionsOrFallbackReason
      : typeof fallbackReasonOrOptions === "string"
        ? fallbackReasonOrOptions
        : undefined
  const resolvedOptions =
    typeof fallbackReasonOrOptions === "object" &&
    fallbackReasonOrOptions !== null &&
    !Array.isArray(fallbackReasonOrOptions)
      ? fallbackReasonOrOptions
      : options
  const target = readAccessBindingTarget(row)
  let capabilityTarget: CapabilityAccessTarget

  switch (target.targetType) {
    case "workspace":
      capabilityTarget = { type: "workspace" }
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
    effectiveConversationTypeMask:
      resolvedOptions?.effectiveConversationTypeMask,
    createdAt: row.created_at,
    revokedAt: row.revoked_at || undefined,
  }
}
