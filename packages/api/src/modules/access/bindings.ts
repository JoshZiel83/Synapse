import type {
  AccessGrant,
  AccessTarget,
  CapabilityAccessTarget,
} from "@synapse/shared/types";
import {
  deleteRelation,
  touchConversationActorContext,
  touchRelation,
  type AuthzObjectType,
  type AuthzRelationMutation,
} from "../../infrastructure/authz/index.js";
import { ensureConversationActorSessionContext } from "../session/service.js";

export type AccessBindableResourceType = Extract<
  AuthzObjectType,
  "installed_skill" | "plugin_installation" | "relay_capability" | "automation_event_source"
>;

export type ResourceAccessBindingStorageRow = {
  resource_type: AccessBindableResourceType;
  installed_skill_id: string | null;
  plugin_installation_id: string | null;
  relay_capability_id: string | null;
  automation_event_source_id: string | null;
};

export type AccessBindingTargetType =
  | "workspace"
  | "conversation"
  | "actor"
  | "actor_in_conversation";

export type AccessBindingRelation =
  | "use_workspace"
  | "use_conversation"
  | "use_actor"
  | "use_actor_in_conversation";

export type AccessBindingRow = ResourceAccessBindingStorageRow & {
  id: string;
  workspace_id: string;
  resource_id: string;
  target_type: AccessBindingTargetType;
  relation: AccessBindingRelation;
  subject_workspace_id: string | null;
  subject_workspace_member_id: string | null;
  subject_actor_id: string | null;
  subject_conversation_id: string | null;
  subject_conversation_actor_context_id: string | null;
  conversation_type_mask_override: number | null;
  granted_permissions: string[] | unknown;
  status: "active" | "revoked";
  created_by_workspace_member_id: string | null;
  reason: string | null;
  created_at: string;
  revoked_at: string | null;
};

export function readAccessBindingResourceId(
  row: Pick<
    ResourceAccessBindingStorageRow,
    | "resource_type"
    | "installed_skill_id"
    | "plugin_installation_id"
    | "relay_capability_id"
    | "automation_event_source_id"
  >,
) {
  switch (row.resource_type) {
    case "installed_skill":
      if (!row.installed_skill_id) {
        throw new Error("installed_skill_id is required for installed_skill bindings");
      }
      return row.installed_skill_id;
    case "plugin_installation":
      if (!row.plugin_installation_id) {
        throw new Error(
          "plugin_installation_id is required for plugin_installation bindings",
        );
      }
      return row.plugin_installation_id;
    case "relay_capability":
      if (!row.relay_capability_id) {
        throw new Error("relay_capability_id is required for relay_capability bindings");
      }
      return row.relay_capability_id;
    case "automation_event_source":
      if (!row.automation_event_source_id) {
        throw new Error(
          "automation_event_source_id is required for automation_event_source bindings",
        );
      }
      return row.automation_event_source_id;
    default:
      throw new Error(`Unsupported access binding resource type: ${String(row.resource_type)}`);
  }
}

export function buildResourceAccessBindingRef(input: {
  resourceType: AccessBindableResourceType;
  resourceId: string;
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
      input.resourceType === "automation_event_source" ? input.resourceId : null,
  };
}

export function relationForAccessTargetType(
  targetType: AccessBindingTargetType,
): AccessBindingRelation {
  switch (targetType) {
    case "workspace":
      return "use_workspace";
    case "conversation":
      return "use_conversation";
    case "actor":
      return "use_actor";
    case "actor_in_conversation":
      return "use_actor_in_conversation";
    default:
      throw new Error(`Unsupported access binding target type: ${String(targetType)}`);
  }
}

export function normalizeAccessBindingRow<
  T extends ResourceAccessBindingStorageRow & { target_type: AccessBindingTargetType },
>(
  row: T,
): T & { resource_id: string; relation: AccessBindingRelation } {
  return {
    ...row,
    resource_id: readAccessBindingResourceId(row),
    relation: relationForAccessTargetType(row.target_type),
  };
}

export type AccessGrantTarget = {
  targetType: AccessTarget["type"];
  bindScope: AccessTarget["type"];
  relation: AccessBindingRow["relation"];
  subjectType:
    | "workspace"
    | "conversation"
    | "actor"
    | "conversation_actor_context";
  subjectWorkspaceId: string | null;
  subjectWorkspaceMemberId: string | null;
  subjectActorId: string | null;
  subjectConversationId: string | null;
  subjectConversationActorContextId: string | null;
  subjectId: string;
  actorId: string | null;
  conversationId: string | null;
  workspaceMemberId: string | null;
};

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) return [] as string[];
  return value.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim().length > 0,
  );
}

export async function resolveAccessGrantTarget(input: {
  workspaceId: string;
  target: AccessTarget;
}): Promise<AccessGrantTarget> {
  switch (input.target.type) {
    case "workspace":
      return {
        targetType: "workspace",
        bindScope: "workspace",
        relation: relationForAccessTargetType("workspace"),
        subjectType: "workspace",
        subjectWorkspaceId: input.workspaceId,
        subjectWorkspaceMemberId: null,
        subjectActorId: null,
        subjectConversationId: null,
        subjectConversationActorContextId: null,
        subjectId: input.workspaceId,
        actorId: null,
        conversationId: null,
        workspaceMemberId: null,
      };
    case "conversation":
      if (!input.target.conversationId) {
        throw new Error("conversationId is required for conversation target");
      }
      return {
        targetType: "conversation",
        bindScope: "conversation",
        relation: relationForAccessTargetType("conversation"),
        subjectType: "conversation",
        subjectWorkspaceId: null,
        subjectWorkspaceMemberId: null,
        subjectActorId: null,
        subjectConversationId: input.target.conversationId,
        subjectConversationActorContextId: null,
        subjectId: input.target.conversationId,
        actorId: null,
        conversationId: input.target.conversationId,
        workspaceMemberId: null,
      };
    case "actor":
      if (!input.target.actorId) {
        throw new Error("actorId is required for actor target");
      }
      return {
        targetType: "actor",
        bindScope: "actor",
        relation: relationForAccessTargetType("actor"),
        subjectType: "actor",
        subjectWorkspaceId: null,
        subjectWorkspaceMemberId: null,
        subjectActorId: input.target.actorId,
        subjectConversationId: null,
        subjectConversationActorContextId: null,
        subjectId: input.target.actorId,
        actorId: input.target.actorId,
        conversationId: null,
        workspaceMemberId: null,
      };
    case "actor_in_conversation": {
      if (!input.target.actorId || !input.target.conversationId) {
        throw new Error(
          "actorId and conversationId are required for actor_in_conversation target",
        );
      }
      const context = await ensureConversationActorSessionContext({
        workspaceId: input.workspaceId,
        actorId: input.target.actorId,
        conversationId: input.target.conversationId,
      });
      return {
        targetType: "actor_in_conversation",
        bindScope: "actor_in_conversation",
        relation: relationForAccessTargetType("actor_in_conversation"),
        subjectType: "conversation_actor_context",
        subjectWorkspaceId: null,
        subjectWorkspaceMemberId: null,
        subjectActorId: input.target.actorId,
        subjectConversationId: input.target.conversationId,
        subjectConversationActorContextId:
          context.conversationActorContextId,
        subjectId: context.conversationActorContextId,
        actorId: input.target.actorId,
        conversationId: input.target.conversationId,
        workspaceMemberId: null,
      };
    }
    default:
      throw new Error(`Unsupported access target type: ${String(input.target.type)}`);
  }
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
  >,
): AccessGrantTarget {
  switch (row.target_type) {
    case "workspace":
      return {
        targetType: "workspace",
        bindScope: "workspace",
        relation: relationForAccessTargetType(row.target_type),
        subjectType: "workspace",
        subjectWorkspaceId: row.subject_workspace_id,
        subjectWorkspaceMemberId: null,
        subjectActorId: null,
        subjectConversationId: null,
        subjectConversationActorContextId: null,
        subjectId: row.subject_workspace_id || "",
        actorId: null,
        conversationId: null,
        workspaceMemberId: null,
      };
    case "conversation":
      return {
        targetType: "conversation",
        bindScope: "conversation",
        relation: relationForAccessTargetType(row.target_type),
        subjectType: "conversation",
        subjectWorkspaceId: null,
        subjectWorkspaceMemberId: null,
        subjectActorId: null,
        subjectConversationId: row.subject_conversation_id,
        subjectConversationActorContextId: null,
        subjectId: row.subject_conversation_id || "",
        actorId: null,
        conversationId: row.subject_conversation_id,
        workspaceMemberId: null,
      };
    case "actor":
      return {
        targetType: "actor",
        bindScope: "actor",
        relation: relationForAccessTargetType(row.target_type),
        subjectType: "actor",
        subjectWorkspaceId: null,
        subjectWorkspaceMemberId: null,
        subjectActorId: row.subject_actor_id,
        subjectConversationId: null,
        subjectConversationActorContextId: null,
        subjectId: row.subject_actor_id || "",
        actorId: row.subject_actor_id,
        conversationId: null,
        workspaceMemberId: null,
      };
    case "actor_in_conversation":
      return {
        targetType: "actor_in_conversation",
        bindScope: "actor_in_conversation",
        relation: relationForAccessTargetType(row.target_type),
        subjectType: "conversation_actor_context",
        subjectWorkspaceId: null,
        subjectWorkspaceMemberId: null,
        subjectActorId: row.subject_actor_id,
        subjectConversationId: row.subject_conversation_id,
        subjectConversationActorContextId:
          row.subject_conversation_actor_context_id,
        subjectId: row.subject_conversation_actor_context_id || "",
        actorId: row.subject_actor_id,
        conversationId: row.subject_conversation_id,
        workspaceMemberId: null,
      };
    default:
      throw new Error(`Unsupported stored access target type: ${String(row.target_type)}`);
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
  target: AccessGrantTarget,
) {
  return (
    row.target_type === target.targetType &&
    (row.subject_workspace_id || null) === (target.subjectWorkspaceId || null) &&
    (row.subject_workspace_member_id || null) ===
      (target.subjectWorkspaceMemberId || null) &&
    (row.subject_actor_id || null) === (target.subjectActorId || null) &&
    (row.subject_conversation_id || null) ===
      (target.subjectConversationId || null) &&
    (row.subject_conversation_actor_context_id || null) ===
      (target.subjectConversationActorContextId || null)
  );
}

function buildAuthzSubject(target: AccessGrantTarget) {
  switch (target.subjectType) {
    case "workspace":
      if (!target.subjectWorkspaceId) {
        throw new Error("subjectWorkspaceId is required for workspace bindings");
      }
      return {
        subjectType: "workspace" as const,
        subjectId: target.subjectWorkspaceId,
      };
    case "conversation":
      if (!target.subjectConversationId) {
        throw new Error(
          "subjectConversationId is required for conversation bindings",
        );
      }
      return {
        subjectType: "conversation" as const,
        subjectId: target.subjectConversationId,
      };
    case "actor":
      if (!target.subjectActorId) {
        throw new Error("subjectActorId is required for actor bindings");
      }
      return {
        subjectType: "actor" as const,
        subjectId: target.subjectActorId,
      };
    case "conversation_actor_context":
      if (!target.subjectConversationActorContextId) {
        throw new Error(
          "subjectConversationActorContextId is required for actor_in_conversation bindings",
        );
      }
      return {
        subjectType: "conversation_actor_context" as const,
        subjectId: target.subjectConversationActorContextId,
      };
    default:
      throw new Error(`Unsupported access binding subject type: ${String(target.subjectType)}`);
  }
}

export function buildResourceAccessAuthzMutations(params: {
  resourceType: AccessBindableResourceType;
  resourceId: string;
  target: AccessGrantTarget;
  operation: "touch" | "delete";
  workspaceId?: string;
}) {
  const mutate = params.operation === "delete" ? deleteRelation : touchRelation;
  const relations: AuthzRelationMutation[] = [];

  if (params.operation === "touch") {
    if (
      params.target.targetType === "actor_in_conversation" &&
      params.target.subjectConversationActorContextId &&
      params.target.subjectActorId &&
      params.target.subjectConversationId
    ) {
      relations.push(
        ...touchConversationActorContext({
          conversationActorContextId:
            params.target.subjectConversationActorContextId,
          actorId: params.target.subjectActorId,
          conversationId: params.target.subjectConversationId,
        }),
      );
    }
  }

  const authzSubject = buildAuthzSubject(params.target);
  relations.push(
    mutate(
      params.resourceType,
      params.resourceId,
      params.target.relation,
      authzSubject.subjectType as AuthzObjectType,
      authzSubject.subjectId,
    ),
  );

  return relations;
}

export function mapAccessBindingToGrant(
  row: AccessBindingRow,
  defaultPermissions: string[] = [],
  fallbackReason?: string,
  options?: {
    effectiveConversationTypeMask?: number;
  },
): AccessGrant {
  const target = readAccessBindingTarget(row);
  const grantedPermissions = asStringArray(row.granted_permissions);
  let capabilityTarget: CapabilityAccessTarget;

  switch (target.targetType) {
    case "workspace":
      capabilityTarget = { type: "workspace" };
      break;
    case "conversation":
      capabilityTarget = {
        type: "conversation",
        conversationId: target.subjectConversationId || undefined,
      };
      break;
    case "actor":
      capabilityTarget = {
        type: "actor",
        actorId: target.subjectActorId || undefined,
      };
      break;
    case "actor_in_conversation":
      capabilityTarget = {
        type: "actor_in_conversation",
        actorId: target.subjectActorId || undefined,
        conversationId: target.subjectConversationId || undefined,
      };
      break;
    default:
      throw new Error(`Unsupported capability access target type: ${String(target.targetType)}`);
  }

  return {
    id: row.id,
    resourceId: row.resource_id,
    workspaceId: row.workspace_id || "",
    target: capabilityTarget,
    permissions:
      grantedPermissions.length > 0 ? grantedPermissions : defaultPermissions,
    status: row.status,
    grantedByWorkspaceMemberId:
      row.created_by_workspace_member_id || undefined,
    reason: row.reason || fallbackReason,
    conversationTypeMaskOverride: row.conversation_type_mask_override ?? null,
    effectiveConversationTypeMask:
      options?.effectiveConversationTypeMask,
    createdAt: row.created_at,
    revokedAt: row.revoked_at || undefined,
  };
}
