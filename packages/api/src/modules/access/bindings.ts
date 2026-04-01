import type {
  AccessGrant,
  AccessTarget,
  CapabilityAccessTarget,
} from "@synapse/shared/types";
import {
  buildActorConversationContextId,
  buildConversationWorkspaceContextId,
  buildWorkspaceMemberContextId,
  deleteRelation,
  touchActorConversationContext,
  touchConversationWorkspaceContext,
  touchRelation,
  touchWorkspaceMemberContext,
  type AuthzObjectType,
  type AuthzRelationMutation,
} from "../../infrastructure/authz/index.js";

export type AccessBindableResourceType = Extract<
  AuthzObjectType,
  "installed_skill" | "plugin_installation" | "relay_exposure"
>;

export type AccessBindingRow = {
  id: string;
  workspace_id: string | null;
  resource_type: string;
  resource_id: string;
  target_type:
    | "workspace"
    | "actor"
    | "workspace_member"
    | "conversation_workspace"
    | "actor_conversation";
  relation:
    | "use_workspace"
    | "use_actor"
    | "use_workspace_member"
    | "use_conversation_workspace"
    | "use_actor_conversation";
  subject_workspace_id: string | null;
  subject_workspace_member_id: string | null;
  subject_actor_id: string | null;
  subject_conversation_id: string | null;
  is_primary: boolean;
  granted_permissions: string[] | unknown;
  status: "active" | "revoked";
  created_by_workspace_member_id: string | null;
  reason: string | null;
  metadata: unknown;
  created_at: string;
  revoked_at: string | null;
};

export type AccessGrantTarget = {
  targetType: AccessTarget["type"];
  bindScope: AccessTarget["type"];
  relation: AccessBindingRow["relation"];
  subjectType:
    | "workspace"
    | "actor"
    | "workspace_member"
    | "conversation_workspace"
    | "actor_conversation";
  subjectWorkspaceId: string | null;
  subjectWorkspaceMemberId: string | null;
  subjectActorId: string | null;
  subjectConversationId: string | null;
  subjectId: string;
  actorId: string | null;
  conversationId: string | null;
  workspaceMemberId: string | null;
};

function asObject(value: unknown) {
  if (!value) return {} as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) return [] as string[];
  return value.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim().length > 0,
  );
}

export function resolveAccessGrantTarget(input: {
  workspaceId: string;
  target: AccessTarget;
}): AccessGrantTarget {
  switch (input.target.type) {
    case "workspace":
      return {
        targetType: "workspace",
        bindScope: "workspace",
        relation: "use_workspace",
        subjectType: "workspace",
        subjectWorkspaceId: input.workspaceId,
        subjectWorkspaceMemberId: null,
        subjectActorId: null,
        subjectConversationId: null,
        subjectId: input.workspaceId,
        actorId: null,
        conversationId: null,
        workspaceMemberId: null,
      };
    case "actor":
      if (!input.target.actorId) {
        throw new Error("actorId is required for actor target");
      }
      return {
        targetType: "actor",
        bindScope: "actor",
        relation: "use_actor",
        subjectType: "actor",
        subjectWorkspaceId: null,
        subjectWorkspaceMemberId: null,
        subjectActorId: input.target.actorId,
        subjectConversationId: null,
        subjectId: input.target.actorId,
        actorId: input.target.actorId,
        conversationId: null,
        workspaceMemberId: null,
      };
    case "workspace_member":
      if (!input.target.workspaceMemberId) {
        throw new Error(
          "workspaceMemberId is required for workspace_member target",
        );
      }
      return {
        targetType: "workspace_member",
        bindScope: "workspace_member",
        relation: "use_workspace_member",
        subjectType: "workspace_member",
        subjectWorkspaceId: null,
        subjectWorkspaceMemberId: input.target.workspaceMemberId,
        subjectActorId: null,
        subjectConversationId: null,
        subjectId: buildWorkspaceMemberContextId(
          input.target.workspaceMemberId,
        ),
        actorId: null,
        conversationId: null,
        workspaceMemberId: input.target.workspaceMemberId,
      };
    case "conversation_workspace":
      if (!input.target.conversationId) {
        throw new Error(
          "conversationId is required for conversation_workspace target",
        );
      }
      return {
        targetType: "conversation_workspace",
        bindScope: "conversation_workspace",
        relation: "use_conversation_workspace",
        subjectType: "conversation_workspace",
        subjectWorkspaceId: input.workspaceId,
        subjectWorkspaceMemberId: null,
        subjectActorId: null,
        subjectConversationId: input.target.conversationId,
        subjectId: buildConversationWorkspaceContextId(
          input.workspaceId,
          input.target.conversationId,
        ),
        actorId: null,
        conversationId: input.target.conversationId,
        workspaceMemberId: null,
      };
    case "actor_conversation":
      if (!input.target.actorId || !input.target.conversationId) {
        throw new Error(
          "actorId and conversationId are required for actor_conversation target",
        );
      }
      return {
        targetType: "actor_conversation",
        bindScope: "actor_conversation",
        relation: "use_actor_conversation",
        subjectType: "actor_conversation",
        subjectWorkspaceId: null,
        subjectWorkspaceMemberId: null,
        subjectActorId: input.target.actorId,
        subjectConversationId: input.target.conversationId,
        subjectId: buildActorConversationContextId(
          input.target.actorId,
          input.target.conversationId,
        ),
        actorId: input.target.actorId,
        conversationId: input.target.conversationId,
        workspaceMemberId: null,
      };
  }
}

export function readAccessBindingTarget(
  row: Pick<
    AccessBindingRow,
    | "target_type"
    | "relation"
    | "subject_workspace_id"
    | "subject_workspace_member_id"
    | "subject_actor_id"
    | "subject_conversation_id"
  >,
): AccessGrantTarget {
  switch (row.target_type) {
    case "workspace":
      return {
        targetType: "workspace",
        bindScope: "workspace",
        relation: row.relation,
        subjectType: "workspace",
        subjectWorkspaceId: row.subject_workspace_id,
        subjectWorkspaceMemberId: null,
        subjectActorId: null,
        subjectConversationId: null,
        subjectId: row.subject_workspace_id || "",
        actorId: null,
        conversationId: null,
        workspaceMemberId: null,
      };
    case "actor":
      return {
        targetType: "actor",
        bindScope: "actor",
        relation: row.relation,
        subjectType: "actor",
        subjectWorkspaceId: null,
        subjectWorkspaceMemberId: null,
        subjectActorId: row.subject_actor_id,
        subjectConversationId: null,
        subjectId: row.subject_actor_id || "",
        actorId: row.subject_actor_id,
        conversationId: null,
        workspaceMemberId: null,
      };
    case "workspace_member":
      return {
        targetType: "workspace_member",
        bindScope: "workspace_member",
        relation: row.relation,
        subjectType: "workspace_member",
        subjectWorkspaceId: null,
        subjectWorkspaceMemberId: row.subject_workspace_member_id,
        subjectActorId: null,
        subjectConversationId: null,
        subjectId: row.subject_workspace_member_id
          ? buildWorkspaceMemberContextId(row.subject_workspace_member_id)
          : "",
        actorId: null,
        conversationId: null,
        workspaceMemberId: row.subject_workspace_member_id,
      };
    case "conversation_workspace":
      return {
        targetType: "conversation_workspace",
        bindScope: "conversation_workspace",
        relation: row.relation,
        subjectType: "conversation_workspace",
        subjectWorkspaceId: row.subject_workspace_id,
        subjectWorkspaceMemberId: null,
        subjectActorId: null,
        subjectConversationId: row.subject_conversation_id,
        subjectId:
          row.subject_workspace_id && row.subject_conversation_id
            ? buildConversationWorkspaceContextId(
                row.subject_workspace_id,
                row.subject_conversation_id,
              )
            : "",
        actorId: null,
        conversationId: row.subject_conversation_id,
        workspaceMemberId: null,
      };
    case "actor_conversation":
      return {
        targetType: "actor_conversation",
        bindScope: "actor_conversation",
        relation: row.relation,
        subjectType: "actor_conversation",
        subjectWorkspaceId: null,
        subjectWorkspaceMemberId: null,
        subjectActorId: row.subject_actor_id,
        subjectConversationId: row.subject_conversation_id,
        subjectId:
          row.subject_actor_id && row.subject_conversation_id
            ? buildActorConversationContextId(
                row.subject_actor_id,
                row.subject_conversation_id,
              )
            : "",
        actorId: row.subject_actor_id,
        conversationId: row.subject_conversation_id,
        workspaceMemberId: null,
      };
  }
}

export function accessBindingMetadata(
  row: Pick<AccessBindingRow, "metadata"> | unknown,
) {
  if (
    row &&
    typeof row === "object" &&
    "metadata" in (row as Record<string, unknown>)
  ) {
    return asObject((row as Pick<AccessBindingRow, "metadata">).metadata);
  }
  return asObject(row);
}

export function isPrimaryAccessBinding(
  row: Pick<AccessBindingRow, "is_primary"> | unknown,
) {
  return (
    !!row &&
    typeof row === "object" &&
    "is_primary" in (row as Record<string, unknown>) &&
    (row as Pick<AccessBindingRow, "is_primary">).is_primary === true
  );
}

export function accessBindingHasTarget(
  row: Pick<
    AccessBindingRow,
    | "target_type"
    | "subject_workspace_id"
    | "subject_workspace_member_id"
    | "subject_actor_id"
    | "subject_conversation_id"
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
      (target.subjectConversationId || null)
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
    case "actor":
      if (!target.subjectActorId) {
        throw new Error("subjectActorId is required for actor bindings");
      }
      return {
        subjectType: "actor" as const,
        subjectId: target.subjectActorId,
      };
    case "workspace_member":
      if (!target.subjectWorkspaceMemberId) {
        throw new Error(
          "subjectWorkspaceMemberId is required for workspace_member bindings",
        );
      }
      return {
        subjectType: "workspace_member" as const,
        subjectId: buildWorkspaceMemberContextId(
          target.subjectWorkspaceMemberId,
        ),
      };
    case "conversation_workspace":
      if (!target.subjectWorkspaceId || !target.subjectConversationId) {
        throw new Error(
          "subjectWorkspaceId and subjectConversationId are required for conversation_workspace bindings",
        );
      }
      return {
        subjectType: "conversation_workspace" as const,
        subjectId: buildConversationWorkspaceContextId(
          target.subjectWorkspaceId,
          target.subjectConversationId,
        ),
      };
    case "actor_conversation":
      if (!target.subjectActorId || !target.subjectConversationId) {
        throw new Error(
          "subjectActorId and subjectConversationId are required for actor_conversation bindings",
        );
      }
      return {
        subjectType: "actor_conversation" as const,
        subjectId: buildActorConversationContextId(
          target.subjectActorId,
          target.subjectConversationId,
        ),
      };
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
      params.target.targetType === "workspace_member" &&
      params.target.subjectWorkspaceMemberId
    ) {
      relations.push(
        ...touchWorkspaceMemberContext({
          workspaceMemberId: params.target.subjectWorkspaceMemberId,
        }),
      );
    }
    if (
      params.target.targetType === "conversation_workspace" &&
      params.target.subjectWorkspaceId &&
      params.target.subjectConversationId
    ) {
      relations.push(
        ...touchConversationWorkspaceContext(
          params.target.subjectWorkspaceId,
          params.target.subjectConversationId,
        ),
      );
    }
    if (
      params.target.targetType === "actor_conversation" &&
      params.target.subjectActorId &&
      params.target.subjectConversationId
    ) {
      relations.push(
        ...touchActorConversationContext(
          params.target.subjectActorId,
          params.target.subjectConversationId,
        ),
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
): AccessGrant {
  const metadata = accessBindingMetadata(row);
  const target = readAccessBindingTarget(row);
  const grantedPermissions = asStringArray(row.granted_permissions);
  let capabilityTarget: CapabilityAccessTarget;

  switch (target.targetType) {
    case "workspace":
      capabilityTarget = { type: "workspace" };
      break;
    case "actor":
      capabilityTarget = {
        type: "actor",
        actorId: target.subjectActorId || undefined,
      };
      break;
    case "conversation_workspace":
      capabilityTarget = {
        type: "conversation_workspace",
        conversationId: target.subjectConversationId || undefined,
      };
      break;
    case "actor_conversation":
      capabilityTarget = {
        type: "actor_conversation",
        actorId: target.subjectActorId || undefined,
        conversationId: target.subjectConversationId || undefined,
      };
      break;
    case "workspace_member":
      throw new Error(
        "workspace_member access targets are not supported for capability grants",
      );
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
    metadata,
    createdAt: row.created_at,
    revokedAt: row.revoked_at || undefined,
  };
}
