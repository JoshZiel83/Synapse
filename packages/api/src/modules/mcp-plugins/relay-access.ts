import type pg from "pg";
import type { AccessGrant, AccessGrantScope } from "@synapse/shared/types";
import {
  buildActorConversationContextId,
  deleteRelation,
  flushAuthzOutboxEntries,
  queueAuthzRelationships,
  touchActorConversationContext,
  touchRelation,
  type AuthzRelationMutation,
} from "../../infrastructure/authz/index.js";
import { transaction } from "../../infrastructure/database/index.js";
import { executeSql, executeSqlOn } from "../../infrastructure/database/kysely.js";
import { incrementMcpVersion } from "./instance-manager.js";

type Queryable = Pick<pg.PoolClient, "query">;

type AccessBindingRow = {
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

const RELAY_EXPOSURE_PERMISSION_SUMMARY = {
  requiredPermissions: ["invoke"],
  suggestedGrantScope: "workspace" as const,
  reason: "Relay exposure access controls who can invoke tools from this relay exposure.",
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

function normalizeGrantTarget(input: {
  grantScope: Exclude<AccessGrantScope, "platform">;
  actorId?: string | null;
  conversationId?: string | null;
  userId?: string | null;
}) {
  switch (input.grantScope) {
    case "workspace":
      return {
        relation: "use_workspace",
        subjectType: "workspace",
        subjectId: null,
        actorId: null,
        conversationId: null,
        userId: null,
      } as const;
    case "conversation":
      if (!input.conversationId) {
        throw new Error("conversationId is required for conversation scope");
      }
      return {
        relation: "use_conversation",
        subjectType: "conversation",
        subjectId: input.conversationId,
        actorId: null,
        conversationId: input.conversationId,
        userId: null,
      } as const;
    case "actor_global":
      if (!input.actorId) {
        throw new Error("actorId is required for actor scope");
      }
      return {
        relation: "use_principal",
        subjectType: "actor",
        subjectId: input.actorId,
        actorId: input.actorId,
        conversationId: null,
        userId: null,
      } as const;
    case "actor_conversation":
      if (!input.actorId || !input.conversationId) {
        throw new Error("actorId and conversationId are required for actor_conversation scope");
      }
      return {
        relation: "use_actor_conversation",
        subjectType: "actor_conversation",
        subjectId: buildActorConversationContextId(input.actorId, input.conversationId),
        actorId: input.actorId,
        conversationId: input.conversationId,
        userId: null,
      } as const;
    case "user":
      if (!input.userId) {
        throw new Error("userId is required for user scope");
      }
      return {
        relation: "use_principal",
        subjectType: "user",
        subjectId: input.userId,
        actorId: null,
        conversationId: null,
        userId: input.userId,
      } as const;
  }
}

function inferGrantScope(row: AccessBindingRow): Exclude<AccessGrantScope, "platform"> {
  if (row.relation === "use_workspace") return "workspace";
  if (row.relation === "use_conversation") return "conversation";
  if (row.relation === "use_actor_conversation") return "actor_conversation";
  if (row.relation === "use_principal" && row.subject_type === "actor") {
    return "actor_global";
  }
  return "user";
}

function mapAccessBindingToGrant(row: AccessBindingRow): AccessGrant {
  const metadata = asObject(row.metadata);
  return {
    id: row.id,
    resourceId: row.resource_id,
    workspaceId: row.workspace_id || "",
    grantScope: inferGrantScope(row),
    conversationId:
      typeof metadata.conversationId === "string" ? metadata.conversationId : undefined,
    actorId:
      typeof metadata.actorId === "string" ? metadata.actorId : undefined,
    userId:
      typeof metadata.userId === "string" ? metadata.userId : undefined,
    permissions: ["invoke"],
    status: row.status,
    grantedBy: row.created_by || undefined,
    reason: row.reason || undefined,
    metadata,
    createdAt: row.created_at,
    revokedAt: row.revoked_at || undefined,
  };
}

export function buildRelayDeviceAuthzMutations(params: {
  deviceId: string;
  workspaceId: string;
  ownerUserId?: string | null;
  operation: "touch" | "delete";
}) {
  const mutate = params.operation === "delete" ? deleteRelation : touchRelation;
  const relations: AuthzRelationMutation[] = [
    mutate("relay_device", params.deviceId, "workspace", "workspace", params.workspaceId),
  ];

  if (params.ownerUserId) {
    relations.push(
      mutate("relay_device", params.deviceId, "owner", "user", params.ownerUserId),
    );
  }

  return relations;
}

export function buildRelayExposureBaseAuthzMutations(params: {
  exposureId: string;
  deviceId: string;
  workspaceId: string;
  operation: "touch" | "delete";
}) {
  const mutate = params.operation === "delete" ? deleteRelation : touchRelation;
  return [
    mutate("relay_exposure", params.exposureId, "workspace", "workspace", params.workspaceId),
    mutate("relay_exposure", params.exposureId, "device", "relay_device", params.deviceId),
  ] satisfies AuthzRelationMutation[];
}

function buildRelayExposureAccessAuthzMutations(params: {
  exposureId: string;
  workspaceId: string;
  relation: string;
  subjectType: string;
  subjectId: string;
  operation: "touch" | "delete";
  actorId?: string | null;
  conversationId?: string | null;
}) {
  const mutate = params.operation === "delete" ? deleteRelation : touchRelation;
  const relations: AuthzRelationMutation[] = [];

  if (
    params.operation === "touch" &&
    params.subjectType === "actor_conversation" &&
    params.actorId &&
    params.conversationId
  ) {
    relations.push(
      ...touchActorConversationContext(params.actorId, params.conversationId),
    );
  }

  relations.push(
    mutate(
      "relay_exposure",
      params.exposureId,
      params.relation,
      params.subjectType as any,
      params.subjectId,
    ),
  );

  return relations;
}

async function flushRelayAuthzEntries(entryIds: string[], source: string) {
  if (entryIds.length === 0) return;
  try {
    await flushAuthzOutboxEntries(entryIds);
  } catch (error) {
    console.error(`[authz] Failed to flush ${source}:`, error);
  }
}

export async function ensureRelayExposureDefaultAccess(params: {
  workspaceId: string;
  exposureId: string;
}) {
  const authzEntryIds = await transaction(async (client) => {
    const existing = await executeSqlOn<{ id: string }>(client, 
      `SELECT id
       FROM access_bindings
       WHERE resource_type = 'relay_exposure'
         AND resource_id = $1
       LIMIT 1`,
      [params.exposureId],
    );

    if (existing.rows.length > 0) {
      return [] as string[];
    }

    const inserted = await executeSqlOn<AccessBindingRow>(client, 
      `INSERT INTO access_bindings (
         workspace_id,
         resource_type,
         resource_id,
         relation,
         subject_type,
         subject_id,
         status,
         reason,
         metadata
       )
       VALUES (
         $1, 'relay_exposure', $2, 'use_workspace', 'workspace', $3, 'active', $4, $5::jsonb
       )
       RETURNING *`,
      [
        params.workspaceId,
        params.exposureId,
        params.workspaceId,
        RELAY_EXPOSURE_PERMISSION_SUMMARY.reason,
        JSON.stringify({
          isDefault: true,
          grantScope: "workspace",
        }),
      ],
    );

    return queueAuthzRelationships(
      client,
      buildRelayExposureAccessAuthzMutations({
        exposureId: params.exposureId,
        workspaceId: params.workspaceId,
        relation: "use_workspace",
        subjectType: "workspace",
        subjectId: params.workspaceId,
        operation: "touch",
      }),
      {
        source: "relay.exposure.default_access",
        workspaceId: params.workspaceId,
        exposureId: params.exposureId,
        bindingId: inserted.rows[0]!.id,
      },
    );
  });

  await flushRelayAuthzEntries(authzEntryIds, "relay.exposure.default_access");
}

export async function touchRelayDeviceAuthzState(params: {
  workspaceId: string;
  deviceId: string;
  ownerUserId?: string | null;
}) {
  const authzEntryIds = await transaction(async (client) =>
    queueAuthzRelationships(
      client,
      buildRelayDeviceAuthzMutations({
        deviceId: params.deviceId,
        workspaceId: params.workspaceId,
        ownerUserId: params.ownerUserId,
        operation: "touch",
      }),
      {
        source: "relay.device.touch",
        workspaceId: params.workspaceId,
        deviceId: params.deviceId,
      },
    ),
  );
  await flushRelayAuthzEntries(authzEntryIds, "relay.device.touch");
}

export async function touchRelayExposureAuthzState(params: {
  workspaceId: string;
  deviceId: string;
  exposureId: string;
}) {
  const authzEntryIds = await transaction(async (client) =>
    queueAuthzRelationships(
      client,
      buildRelayExposureBaseAuthzMutations({
        exposureId: params.exposureId,
        deviceId: params.deviceId,
        workspaceId: params.workspaceId,
        operation: "touch",
      }),
      {
        source: "relay.exposure.touch",
        workspaceId: params.workspaceId,
        exposureId: params.exposureId,
        deviceId: params.deviceId,
      },
    ),
  );
  await flushRelayAuthzEntries(authzEntryIds, "relay.exposure.touch");
  await ensureRelayExposureDefaultAccess({
    workspaceId: params.workspaceId,
    exposureId: params.exposureId,
  });
}

export async function listRelayExposureAccessState(
  workspaceId: string,
  exposureId: string,
) {
  const result = await executeSql<AccessBindingRow>(
    `SELECT *
     FROM access_bindings
     WHERE workspace_id = $1
       AND resource_type = 'relay_exposure'
       AND resource_id = $2
       AND status = 'active'
     ORDER BY created_at ASC`,
    [workspaceId, exposureId],
  );

  const grants = result.rows.map(mapAccessBindingToGrant);
  return {
    grants,
    summary: {
      ...RELAY_EXPOSURE_PERMISSION_SUMMARY,
      effectivePermissions: grants.length > 0 ? ["invoke"] : [],
      isVisible: grants.length > 0,
      isAuthorized: grants.length > 0,
      matchingGrantIds: grants.map((grant) => grant.id),
    },
  };
}

export async function grantRelayExposureAccess(input: {
  workspaceId: string;
  exposureId: string;
  grantScope?: Exclude<AccessGrantScope, "platform">;
  actorId?: string;
  conversationId?: string;
  userId?: string;
  grantedBy?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}) {
  const grantScope = input.grantScope || "workspace";
  const target = normalizeGrantTarget({
    grantScope,
    actorId: input.actorId,
    conversationId: input.conversationId,
    userId: input.userId,
  });
  if (!target) {
    throw new Error(`Unsupported relay exposure grant scope: ${grantScope}`);
  }

  const existing = await executeSql<AccessBindingRow>(
    `SELECT *
     FROM access_bindings
     WHERE workspace_id = $1
       AND resource_type = 'relay_exposure'
       AND resource_id = $2
       AND relation = $3
       AND subject_type = $4
       AND subject_id = $5
       AND status = 'active'
     LIMIT 1`,
    [
      input.workspaceId,
      input.exposureId,
      target.relation,
      target.subjectType,
      target.subjectId || input.workspaceId,
    ],
  );

  if (existing.rows.length > 0) {
    return mapAccessBindingToGrant(existing.rows[0]!);
  }

  const inserted = await transaction(async (client) => {
    const binding = await executeSqlOn<AccessBindingRow>(client, 
      `INSERT INTO access_bindings (
         workspace_id,
         resource_type,
         resource_id,
         relation,
         subject_type,
         subject_id,
         status,
         created_by,
         reason,
         metadata
       )
       VALUES (
         $1, 'relay_exposure', $2, $3, $4, $5, 'active', $6, $7, $8::jsonb
       )
       RETURNING *`,
      [
        input.workspaceId,
        input.exposureId,
        target.relation,
        target.subjectType,
        target.subjectId || input.workspaceId,
        input.grantedBy || null,
        input.reason || RELAY_EXPOSURE_PERMISSION_SUMMARY.reason,
        JSON.stringify({
          ...(input.metadata || {}),
          grantScope,
          actorId: target.actorId,
          conversationId: target.conversationId,
          userId: target.userId,
        }),
      ],
    );

    const authzEntryIds = await queueAuthzRelationships(
      client,
      buildRelayExposureAccessAuthzMutations({
        exposureId: input.exposureId,
        workspaceId: input.workspaceId,
        relation: target.relation,
        subjectType: target.subjectType,
        subjectId: target.subjectId || input.workspaceId,
        actorId: target.actorId,
        conversationId: target.conversationId,
        operation: "touch",
      }),
      {
        source: "relay.exposure.grant",
        workspaceId: input.workspaceId,
        exposureId: input.exposureId,
        bindingId: binding.rows[0]!.id,
      },
    );

    return {
      binding: binding.rows[0]!,
      authzEntryIds,
    };
  });

  await flushRelayAuthzEntries(inserted.authzEntryIds, "relay.exposure.grant");
  await incrementMcpVersion(input.workspaceId);
  return mapAccessBindingToGrant(inserted.binding);
}

export async function revokeRelayExposureAccess(input: {
  workspaceId: string;
  exposureId: string;
  bindingId: string;
}) {
  const result = await executeSql<AccessBindingRow>(
    `SELECT *
     FROM access_bindings
     WHERE id = $1
       AND workspace_id = $2
       AND resource_type = 'relay_exposure'
       AND resource_id = $3
     LIMIT 1`,
    [input.bindingId, input.workspaceId, input.exposureId],
  );

  if (result.rows.length === 0) {
    const error = new Error("Relay exposure access binding not found") as Error & {
      code: string;
    };
    error.code = "RELAY_EXPOSURE_ACCESS_NOT_FOUND";
    throw error;
  }

  const binding = result.rows[0]!;
  const metadata = asObject(binding.metadata);
  const authzEntryIds = await transaction(async (client) => {
    const ids = await queueAuthzRelationships(
      client,
      buildRelayExposureAccessAuthzMutations({
        exposureId: input.exposureId,
        workspaceId: input.workspaceId,
        relation: binding.relation,
        subjectType: binding.subject_type,
        subjectId: binding.subject_id,
        actorId: typeof metadata.actorId === "string" ? metadata.actorId : undefined,
        conversationId:
          typeof metadata.conversationId === "string"
            ? metadata.conversationId
            : undefined,
        operation: "delete",
      }),
      {
        source: "relay.exposure.revoke",
        workspaceId: input.workspaceId,
        exposureId: input.exposureId,
        bindingId: binding.id,
      },
    );

    await executeSqlOn(client, 
      `UPDATE access_bindings
       SET status = 'revoked',
           revoked_at = NOW()
       WHERE id = $1`,
      [binding.id],
    );

    return ids;
  });

  await flushRelayAuthzEntries(authzEntryIds, "relay.exposure.revoke");
  await incrementMcpVersion(input.workspaceId);
}

export async function revokeRelayDeviceAuthzState(input: {
  workspaceId: string;
  deviceId: string;
  ownerUserId?: string | null;
  exposureIds: string[];
}) {
  const activeBindings = input.exposureIds.length > 0
    ? await executeSql<AccessBindingRow>(
        `SELECT *
         FROM access_bindings
         WHERE workspace_id = $1
           AND resource_type = 'relay_exposure'
           AND resource_id = ANY($2::text[])
           AND status = 'active'`,
        [input.workspaceId, input.exposureIds],
      )
    : { rows: [] as AccessBindingRow[] };

  const authzEntryIds = await transaction(async (client) => {
    const ids = await queueAuthzRelationships(
      client,
      [
        ...buildRelayDeviceAuthzMutations({
          deviceId: input.deviceId,
          workspaceId: input.workspaceId,
          ownerUserId: input.ownerUserId,
          operation: "delete",
        }),
        ...input.exposureIds.flatMap((exposureId) =>
          buildRelayExposureBaseAuthzMutations({
            exposureId,
            deviceId: input.deviceId,
            workspaceId: input.workspaceId,
            operation: "delete",
          }),
        ),
        ...activeBindings.rows.flatMap((binding) => {
          const metadata = asObject(binding.metadata);
          return buildRelayExposureAccessAuthzMutations({
            exposureId: binding.resource_id,
            workspaceId: input.workspaceId,
            relation: binding.relation,
            subjectType: binding.subject_type,
            subjectId: binding.subject_id,
            actorId: typeof metadata.actorId === "string" ? metadata.actorId : undefined,
            conversationId:
              typeof metadata.conversationId === "string"
                ? metadata.conversationId
                : undefined,
            operation: "delete",
          });
        }),
      ],
      {
        source: "relay.device.delete",
        workspaceId: input.workspaceId,
        deviceId: input.deviceId,
      },
    );

    if (activeBindings.rows.length > 0) {
      await executeSqlOn(client, 
        `UPDATE access_bindings
         SET status = 'revoked',
             revoked_at = NOW()
         WHERE id = ANY($1::uuid[])`,
        [activeBindings.rows.map((row) => row.id)],
      );
    }

    return ids;
  });

  await flushRelayAuthzEntries(authzEntryIds, "relay.device.delete");
}
