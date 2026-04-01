import type pg from "pg";
import type { CapabilityAccessTarget } from "@synapse/shared/types";
import {
  deleteRelation,
  flushAuthzOutboxEntries,
  queueAuthzRelationships,
  touchRelation,
  type AuthzRelationMutation,
} from "../../infrastructure/authz/index.js";
import { transaction } from "../../infrastructure/database/index.js";
import { executeSql, executeSqlOn } from "../../infrastructure/database/kysely.js";
import {
  buildResourceAccessAuthzMutations,
  mapAccessBindingToGrant,
  readAccessBindingTarget,
  resolveAccessGrantTarget,
  type AccessBindingRow,
} from "../access/bindings.js";
import { incrementMcpVersion } from "./runtime-version.js";

type Queryable = Pick<pg.PoolClient, "query">;

const RELAY_EXPOSURE_PERMISSION_SUMMARY = {
  requiredPermissions: ["invoke"],
  suggestedAccessTargetType: "workspace" as const,
  reason: "Relay exposure access controls who can invoke tools from this relay exposure.",
};

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
         target_type,
         relation,
         subject_workspace_id,
         subject_user_id,
         subject_actor_id,
         subject_conversation_id,
         is_primary,
         granted_permissions,
         status,
         reason,
         metadata
       )
       VALUES (
         $1, 'relay_exposure', $2, 'workspace', 'use_workspace', $3, NULL, NULL, NULL, FALSE, ARRAY['invoke']::text[], 'active', $4, $5::jsonb
       )
       RETURNING *`,
      [
        params.workspaceId,
        params.exposureId,
        params.workspaceId,
        RELAY_EXPOSURE_PERMISSION_SUMMARY.reason,
        JSON.stringify({ isDefault: true }),
      ],
    );

    return queueAuthzRelationships(
      client,
      buildResourceAccessAuthzMutations({
        resourceType: "relay_exposure",
        resourceId: params.exposureId,
        workspaceId: params.workspaceId,
        target: resolveAccessGrantTarget({
          workspaceId: params.workspaceId,
          target: { type: "workspace" },
        }),
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

  const grants = result.rows.map((row) => mapAccessBindingToGrant(row));
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
  accessTarget?: CapabilityAccessTarget;
  grantedBy?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}) {
  const target = resolveAccessGrantTarget({
    workspaceId: input.workspaceId,
    target: input.accessTarget || { type: "workspace" },
  });

  const existing = await executeSql<AccessBindingRow>(
    `SELECT *
     FROM access_bindings
     WHERE workspace_id = $1
       AND resource_type = 'relay_exposure'
       AND resource_id = $2
       AND relation = $3
       AND subject_workspace_id IS NOT DISTINCT FROM $4::uuid
       AND subject_user_id IS NOT DISTINCT FROM $5::uuid
       AND subject_actor_id IS NOT DISTINCT FROM $6::uuid
       AND subject_conversation_id IS NOT DISTINCT FROM $7::uuid
       AND status = 'active'
     LIMIT 1`,
    [
      input.workspaceId,
      input.exposureId,
      target.relation,
      target.subjectWorkspaceId,
      target.subjectUserId,
      target.subjectActorId,
      target.subjectConversationId,
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
         target_type,
         relation,
         subject_workspace_id,
         subject_user_id,
         subject_actor_id,
         subject_conversation_id,
         is_primary,
         granted_permissions,
         status,
         created_by,
         reason,
         metadata
       )
       VALUES (
         $1, 'relay_exposure', $2, $3, $4, $5, $6, $7, $8, FALSE, ARRAY['invoke']::text[], 'active', $9, $10, $11::jsonb
       )
       RETURNING *`,
      [
        input.workspaceId,
        input.exposureId,
        target.targetType,
        target.relation,
        target.subjectWorkspaceId,
        target.subjectUserId,
        target.subjectActorId,
        target.subjectConversationId,
        input.grantedBy || null,
        input.reason || RELAY_EXPOSURE_PERMISSION_SUMMARY.reason,
        JSON.stringify(input.metadata || {}),
      ],
    );

    const authzEntryIds = await queueAuthzRelationships(
      client,
      buildResourceAccessAuthzMutations({
        resourceType: "relay_exposure",
        resourceId: input.exposureId,
        workspaceId: input.workspaceId,
        target,
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
  const authzEntryIds = await transaction(async (client) => {
    const ids = await queueAuthzRelationships(
      client,
      buildResourceAccessAuthzMutations({
        resourceType: "relay_exposure",
        resourceId: input.exposureId,
        workspaceId: input.workspaceId,
        target: readAccessBindingTarget(binding),
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
        ...activeBindings.rows.flatMap((binding) =>
          buildResourceAccessAuthzMutations({
            resourceType: "relay_exposure",
            resourceId: binding.resource_id,
            workspaceId: input.workspaceId,
            target: readAccessBindingTarget(binding),
            operation: "delete",
          }),
        ),
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
