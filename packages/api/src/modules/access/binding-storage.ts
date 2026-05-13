import type { TableInsert } from "../../infrastructure/database/kysely.js"
import type {
  AccessBindableResourceType,
  AccessGrantTarget,
} from "./bindings.js"

export type AccessBindingStorageTarget = Pick<
  TableInsert<"resource_access_bindings">,
  | "target_type"
  | "subject_workspace_id"
  | "subject_actor_id"
  | "subject_conversation_id"
  | "subject_conversation_actor_context_id"
>

export function buildAccessBindingStorageTarget(
  target: Pick<
    AccessGrantTarget,
    | "targetType"
    | "subjectWorkspaceId"
    | "subjectActorId"
    | "subjectConversationId"
    | "subjectConversationActorContextId"
  >
): AccessBindingStorageTarget {
  switch (target.targetType) {
    case "workspace":
      return {
        target_type: "workspace",
        subject_workspace_id: target.subjectWorkspaceId,
        subject_actor_id: null,
        subject_conversation_id: null,
        subject_conversation_actor_context_id: null,
      }
    case "conversation":
      return {
        target_type: "conversation",
        subject_workspace_id: null,
        subject_actor_id: null,
        subject_conversation_id: target.subjectConversationId,
        subject_conversation_actor_context_id: null,
      }
    case "actor":
      return {
        target_type: "actor",
        subject_workspace_id: null,
        subject_actor_id: target.subjectActorId,
        subject_conversation_id: null,
        subject_conversation_actor_context_id: null,
      }
    case "actor_in_conversation":
      return {
        target_type: "actor_in_conversation",
        subject_workspace_id: null,
        subject_actor_id: null,
        subject_conversation_id: null,
        subject_conversation_actor_context_id:
          target.subjectConversationActorContextId,
      }
    default:
      throw new Error(
        `Unsupported access target type: ${String(target.targetType)}`
      )
  }
}

export function buildResourceAccessBindingInsertValues(input: {
  workspaceId: string
  resourceType: AccessBindableResourceType
  resourceId: string
  target: AccessGrantTarget
  conversationTypeMaskOverride?: number | null
  createdByWorkspaceMemberId?: string | null
  reason?: string | null
}) {
  return {
    workspace_id: input.workspaceId,
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
    ...buildAccessBindingStorageTarget(input.target),
    conversation_type_mask_override: input.conversationTypeMaskOverride ?? null,
    status: "active" as const,
    created_by_workspace_member_id: input.createdByWorkspaceMemberId ?? null,
    reason: input.reason ?? null,
  } satisfies TableInsert<"resource_access_bindings">
}
