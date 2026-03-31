import type {
  AccessGrant,
  AccessTarget,
  CapabilityAccessTarget,
} from "@synapse/shared/types";
import {
  buildActorConversationContextId,
  buildConversationWorkspaceContextId,
  buildWorkspaceUserContextId,
  deleteRelation,
  touchActorConversationContext,
  touchConversationWorkspaceContext,
  touchRelation,
  touchWorkspaceUserContext,
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
    | "workspace_user"
    | "conversation_workspace"
    | "actor_conversation";
  relation:
    | "use_workspace"
    | "use_actor"
    | "use_workspace_user"
    | "use_conversation_workspace"
    | "use_actor_conversation";
  subject_type:
    | "workspace"
    | "actor"
    | "workspace_user"
    | "conversation_workspace"
    | "actor_conversation";
  subject_id: string;
  subject_relation: string | null;
  actor_id: string | null;
  conversation_id: string | null;
  user_id: string | null;
  status: "active" | "revoked";
  created_by: string | null;
  reason: string | null;
  metadata: unknown;
  created_at: string;
  revoked_at: string | null;
};

export type AccessGrantTarget = {
  targetType: AccessTarget["type"];
  bindScope: AccessTarget["type"];
  relation: AccessBindingRow["relation"];
  subjectType: AccessBindingRow["subject_type"];
  subjectId: string;
  actorId: string | null;
  conversationId: string | null;
  userId: string | null;
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
        subjectId: input.workspaceId,
        actorId: null,
        conversationId: null,
        userId: null,
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
        subjectId: input.target.actorId,
        actorId: input.target.actorId,
        conversationId: null,
        userId: null,
      };
    case "workspace_user":
      if (!input.target.userId) {
        throw new Error("userId is required for workspace_user target");
      }
      return {
        targetType: "workspace_user",
        bindScope: "workspace_user",
        relation: "use_workspace_user",
        subjectType: "workspace_user",
        subjectId: buildWorkspaceUserContextId(
          input.workspaceId,
          input.target.userId,
        ),
        actorId: null,
        conversationId: null,
        userId: input.target.userId,
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
        subjectId: buildConversationWorkspaceContextId(
          input.workspaceId,
          input.target.conversationId,
        ),
        actorId: null,
        conversationId: input.target.conversationId,
        userId: null,
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
        subjectId: buildActorConversationContextId(
          input.target.actorId,
          input.target.conversationId,
        ),
        actorId: input.target.actorId,
        conversationId: input.target.conversationId,
        userId: null,
      };
  }
}

export function readAccessBindingTarget(
  row: Pick<
    AccessBindingRow,
    "target_type" | "relation" | "subject_type" | "subject_id" | "actor_id" | "conversation_id" | "user_id"
  >,
): AccessGrantTarget {
  return {
    targetType: row.target_type,
    bindScope: row.target_type,
    relation: row.relation,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    actorId: row.actor_id,
    conversationId: row.conversation_id,
    userId: row.user_id,
  };
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
  row: Pick<AccessBindingRow, "metadata"> | unknown,
) {
  return accessBindingMetadata(row).isPrimary === true;
}

export function buildResourceAccessAuthzMutations(params: {
  resourceType: AccessBindableResourceType;
  resourceId: string;
  workspaceId?: string;
  target: AccessGrantTarget;
  operation: "touch" | "delete";
}) {
  const mutate = params.operation === "delete" ? deleteRelation : touchRelation;
  const relations: AuthzRelationMutation[] = [];
  const resolvedWorkspaceId =
    params.workspaceId ||
    (params.target.targetType === "workspace_user" ||
    params.target.targetType === "conversation_workspace"
      ? params.target.subjectId.split("|")[0] || ""
      : "");

  if (params.operation === "touch") {
    if (params.target.targetType === "workspace_user" && params.target.userId) {
      relations.push(
        ...touchWorkspaceUserContext(resolvedWorkspaceId, params.target.userId),
      );
    }
    if (
      params.target.targetType === "conversation_workspace" &&
      params.target.conversationId
    ) {
      relations.push(
        ...touchConversationWorkspaceContext(
          resolvedWorkspaceId,
          params.target.conversationId,
        ),
      );
    }
    if (
      params.target.targetType === "actor_conversation" &&
      params.target.actorId &&
      params.target.conversationId
    ) {
      relations.push(
        ...touchActorConversationContext(
          params.target.actorId,
          params.target.conversationId,
        ),
      );
    }
  }

  relations.push(
    mutate(
      params.resourceType,
      params.resourceId,
      params.target.relation,
      params.target.subjectType as AuthzObjectType,
      params.target.subjectId,
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
  const requestedPermissions = asStringArray(metadata.requestedPermissions);
  let capabilityTarget: CapabilityAccessTarget;

  switch (target.targetType) {
    case "workspace":
      capabilityTarget = { type: "workspace" };
      break;
    case "actor":
      capabilityTarget = {
        type: "actor",
        actorId: target.actorId || undefined,
      };
      break;
    case "conversation_workspace":
      capabilityTarget = {
        type: "conversation_workspace",
        conversationId: target.conversationId || undefined,
      };
      break;
    case "actor_conversation":
      capabilityTarget = {
        type: "actor_conversation",
        actorId: target.actorId || undefined,
        conversationId: target.conversationId || undefined,
      };
      break;
    case "workspace_user":
      throw new Error(
        "workspace_user access targets are not supported for capability grants",
      );
  }

  return {
    id: row.id,
    resourceId: row.resource_id,
    workspaceId: row.workspace_id || "",
    target: capabilityTarget,
    permissions:
      requestedPermissions.length > 0 ? requestedPermissions : defaultPermissions,
    status: row.status,
    grantedBy: row.created_by || undefined,
    reason:
      typeof metadata.reason === "string"
        ? metadata.reason
        : row.reason || fallbackReason,
    metadata,
    createdAt: row.created_at,
    revokedAt: row.revoked_at || undefined,
  };
}
