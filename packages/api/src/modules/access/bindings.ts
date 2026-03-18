import type { AccessGrant, AccessGrantScope } from "@synapse/shared/types";
import type { RuntimeBindingScope } from "@synapse/shared";
import {
  buildActorConversationContextId,
  deleteRelation,
  touchActorConversationContext,
  touchRelation,
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
  relation: string;
  subject_type: string;
  subject_id: string;
  subject_relation: string | null;
  status: "active" | "revoked";
  created_by: string | null;
  reason: string | null;
  metadata: unknown;
  created_at: string;
  revoked_at: string | null;
};

export type AccessGrantTarget = {
  grantScope: Exclude<AccessGrantScope, "platform">;
  bindScope: RuntimeBindingScope;
  relation:
    | "use_workspace"
    | "use_conversation"
    | "use_principal"
    | "use_actor_conversation";
  subjectType: "workspace" | "conversation" | "user" | "actor" | "actor_conversation";
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

export function publicGrantScope(
  bindScope: RuntimeBindingScope,
): Exclude<AccessGrantScope, "platform"> {
  return bindScope === "actor" ? "actor_global" : bindScope;
}

export function internalGrantScope(
  grantScope: Exclude<AccessGrantScope, "platform">,
): RuntimeBindingScope {
  return grantScope === "actor_global" ? "actor" : grantScope;
}

export function resolveAccessGrantTarget(input: {
  workspaceId: string;
  grantScope: Exclude<AccessGrantScope, "platform">;
  actorId?: string | null;
  conversationId?: string | null;
  userId?: string | null;
}): AccessGrantTarget {
  switch (input.grantScope) {
    case "workspace":
      return {
        grantScope: "workspace",
        bindScope: "workspace",
        relation: "use_workspace",
        subjectType: "workspace",
        subjectId: input.workspaceId,
        actorId: null,
        conversationId: null,
        userId: null,
      };
    case "conversation":
      if (!input.conversationId) {
        throw new Error("conversationId is required for conversation scope");
      }
      return {
        grantScope: "conversation",
        bindScope: "conversation",
        relation: "use_conversation",
        subjectType: "conversation",
        subjectId: input.conversationId,
        actorId: null,
        conversationId: input.conversationId,
        userId: null,
      };
    case "actor_global":
      if (!input.actorId) {
        throw new Error("actorId is required for actor_global scope");
      }
      return {
        grantScope: "actor_global",
        bindScope: "actor",
        relation: "use_principal",
        subjectType: "actor",
        subjectId: input.actorId,
        actorId: input.actorId,
        conversationId: null,
        userId: null,
      };
    case "actor_conversation":
      if (!input.actorId || !input.conversationId) {
        throw new Error(
          "actorId and conversationId are required for actor_conversation scope",
        );
      }
      return {
        grantScope: "actor_conversation",
        bindScope: "actor_conversation",
        relation: "use_actor_conversation",
        subjectType: "actor_conversation",
        subjectId: buildActorConversationContextId(
          input.actorId,
          input.conversationId,
        ),
        actorId: input.actorId,
        conversationId: input.conversationId,
        userId: null,
      };
    case "user":
      if (!input.userId) {
        throw new Error("userId is required for user scope");
      }
      return {
        grantScope: "user",
        bindScope: "user",
        relation: "use_principal",
        subjectType: "user",
        subjectId: input.userId,
        actorId: null,
        conversationId: null,
        userId: input.userId,
      };
  }
}

export function readAccessBindingTarget(row: AccessBindingRow): AccessGrantTarget {
  const metadata = asObject(row.metadata);

  if (row.relation === "use_workspace") {
    return {
      grantScope: "workspace",
      bindScope: "workspace",
      relation: "use_workspace",
      subjectType: "workspace",
      subjectId: row.subject_id,
      actorId: null,
      conversationId: null,
      userId: null,
    };
  }

  if (row.relation === "use_conversation") {
    const conversationId =
      typeof metadata.conversationId === "string"
        ? metadata.conversationId
        : row.subject_id;
    return {
      grantScope: "conversation",
      bindScope: "conversation",
      relation: "use_conversation",
      subjectType: "conversation",
      subjectId: row.subject_id,
      actorId: null,
      conversationId,
      userId: null,
    };
  }

  if (row.relation === "use_actor_conversation") {
    return {
      grantScope: "actor_conversation",
      bindScope: "actor_conversation",
      relation: "use_actor_conversation",
      subjectType: "actor_conversation",
      subjectId: row.subject_id,
      actorId:
        typeof metadata.actorId === "string" ? metadata.actorId : null,
      conversationId:
        typeof metadata.conversationId === "string"
          ? metadata.conversationId
          : null,
      userId: null,
    };
  }

  if (row.relation === "use_principal" && row.subject_type === "actor") {
    return {
      grantScope: "actor_global",
      bindScope: "actor",
      relation: "use_principal",
      subjectType: "actor",
      subjectId: row.subject_id,
      actorId:
        typeof metadata.actorId === "string" ? metadata.actorId : row.subject_id,
      conversationId: null,
      userId: null,
    };
  }

  return {
    grantScope: "user",
    bindScope: "user",
    relation: "use_principal",
    subjectType: "user",
    subjectId: row.subject_id,
    actorId: null,
    conversationId: null,
    userId:
      typeof metadata.userId === "string" ? metadata.userId : row.subject_id,
  };
}

export function accessBindingMetadata(row: Pick<AccessBindingRow, "metadata"> | unknown) {
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
  target: AccessGrantTarget;
  operation: "touch" | "delete";
}) {
  const mutate = params.operation === "delete" ? deleteRelation : touchRelation;
  const relations: AuthzRelationMutation[] = [];

  if (
    params.operation === "touch" &&
    params.target.subjectType === "actor_conversation" &&
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

  return {
    id: row.id,
    resourceId: row.resource_id,
    workspaceId: row.workspace_id || "",
    grantScope: target.grantScope,
    conversationId: target.conversationId || undefined,
    actorId: target.actorId || undefined,
    userId: target.userId || undefined,
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
