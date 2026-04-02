import type pg from "pg";
import {
  DEFAULT_CONVERSATION_TYPE_MASK,
  resolveNarrowedConversationTypeMask,
} from "@synapse/shared";
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
import { getWorkspaceCapabilityConversationTypeMask } from "../capabilities/conversation-type-policies.js";
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
  ownerWorkspaceMemberId?: string | null;
  operation: "touch" | "delete";
}) {
  const mutate = params.operation === "delete" ? deleteRelation : touchRelation;
  const relations: AuthzRelationMutation[] = [
    mutate("relay_device", params.deviceId, "workspace", "workspace", params.workspaceId),
  ];

  if (params.ownerWorkspaceMemberId) {
    relations.push(
      mutate(
        "relay_device",
        params.deviceId,
        "owner",
        "workspace_member",
        params.ownerWorkspaceMemberId,
      ),
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

async function loadRelayExposurePolicyState(
  workspaceId: string,
  exposureId: string,
) {
  const result = await executeSql<{
    id: string;
    owner_workspace_id: string;
    conversation_type_mask_override: number | null;
  }>(
    `SELECT
       e.id,
       d.workspace_id AS owner_workspace_id,
       e.conversation_type_mask_override
     FROM relay_exposures e
     INNER JOIN relay_devices d
       ON d.id = e.device_id
     WHERE e.id = $1
       AND d.workspace_id = $2
     LIMIT 1`,
    [exposureId, workspaceId],
  );

  return result.rows[0] || null;
}

async function listRelayExposureAccessRows(
  workspaceId: string,
  exposureId: string,
  includeRevoked = false,
) {
  const result = await executeSql<AccessBindingRow>(
    `SELECT
       binding.id,
       binding.workspace_id,
       binding.resource_type,
       binding.resource_id,
       binding.target_type,
       binding.relation,
       binding.subject_workspace_id,
       binding.subject_workspace_member_id,
       COALESCE(binding.subject_actor_id, cac.actor_id) AS subject_actor_id,
       COALESCE(binding.subject_conversation_id, cac.conversation_id) AS subject_conversation_id,
       binding.subject_conversation_actor_context_id,
       binding.conversation_type_mask_override,
       binding.granted_permissions,
       binding.status,
       binding.created_by_workspace_member_id,
       binding.reason,
       binding.metadata,
       binding.created_at,
       binding.revoked_at
     FROM access_bindings binding
     LEFT JOIN conversation_actor_contexts cac
       ON cac.id = binding.subject_conversation_actor_context_id
     WHERE binding.workspace_id = $1
       AND binding.resource_type = 'relay_exposure'
       AND binding.resource_id = $2
       ${includeRevoked ? "" : "AND binding.status = 'active'"}
     ORDER BY binding.created_at ASC`,
    [workspaceId, exposureId],
  );
  return result.rows;
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
         subject_workspace_member_id,
         subject_actor_id,
         subject_conversation_id,
         granted_permissions,
         status,
         reason,
         metadata
       )
       VALUES (
        $1, 'relay_exposure', $2, 'workspace', 'use_workspace', $3, NULL, NULL, NULL, ARRAY['invoke']::text[], 'active', $4, $5::jsonb
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

    const target = await resolveAccessGrantTarget({
      workspaceId: params.workspaceId,
      target: { type: "workspace" },
    });

    return queueAuthzRelationships(
      client,
      buildResourceAccessAuthzMutations({
        resourceType: "relay_exposure",
        resourceId: params.exposureId,
        workspaceId: params.workspaceId,
        target,
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
  ownerWorkspaceMemberId?: string | null;
}) {
  const authzEntryIds = await transaction(async (client) =>
    queueAuthzRelationships(
      client,
      buildRelayDeviceAuthzMutations({
        deviceId: params.deviceId,
        workspaceId: params.workspaceId,
        ownerWorkspaceMemberId: params.ownerWorkspaceMemberId,
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
  const exposure = await loadRelayExposurePolicyState(workspaceId, exposureId);
  if (!exposure) {
    const error = new Error("Relay exposure not found") as Error & { code: string };
    error.code = "RELAY_EXPOSURE_NOT_FOUND";
    throw error;
  }
  const workspaceConversationTypeMask =
    await getWorkspaceCapabilityConversationTypeMask(
      exposure.owner_workspace_id,
      "relay_exposure",
    );
  const grants = (await listRelayExposureAccessRows(workspaceId, exposureId)).map(
    (row) =>
      mapAccessBindingToGrant(row, ["invoke"], undefined, {
        effectiveConversationTypeMask: resolveNarrowedConversationTypeMask(
          resolveNarrowedConversationTypeMask(
            workspaceConversationTypeMask,
            exposure.conversation_type_mask_override,
          ),
          row.conversation_type_mask_override,
        ),
      }),
  );
  return {
    grants,
    summary: {
      ...RELAY_EXPOSURE_PERMISSION_SUMMARY,
      workspaceConversationTypeMask,
      conversationTypeMaskOverride: exposure.conversation_type_mask_override ?? null,
      effectiveConversationTypeMask: resolveNarrowedConversationTypeMask(
        workspaceConversationTypeMask,
        exposure.conversation_type_mask_override,
      ),
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
  conversationTypeMaskOverride?: number | null;
  grantedByWorkspaceMemberId?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}) {
  const exposure = await loadRelayExposurePolicyState(
    input.workspaceId,
    input.exposureId,
  );
  if (!exposure) {
    const error = new Error("Relay exposure not found") as Error & { code: string };
    error.code = "RELAY_EXPOSURE_NOT_FOUND";
    throw error;
  }
  const workspaceConversationTypeMask =
    await getWorkspaceCapabilityConversationTypeMask(
      exposure.owner_workspace_id,
      "relay_exposure",
    );
  const target = await resolveAccessGrantTarget({
    workspaceId: input.workspaceId,
    target: input.accessTarget || { type: "workspace" },
  });

  const existing = (await listRelayExposureAccessRows(
    input.workspaceId,
    input.exposureId,
  )).find(
    (row) =>
      row.relation === target.relation &&
      (row.subject_workspace_id || null) === (target.subjectWorkspaceId || null) &&
      (row.subject_workspace_member_id || null) ===
        (target.subjectWorkspaceMemberId || null) &&
      (row.subject_actor_id || null) === (target.subjectActorId || null) &&
      (row.subject_conversation_id || null) ===
        (target.subjectConversationId || null) &&
      (row.subject_conversation_actor_context_id || null) ===
        (target.subjectConversationActorContextId || null),
  );

  if (existing) {
    return mapAccessBindingToGrant(existing, ["invoke"], undefined, {
      effectiveConversationTypeMask: resolveNarrowedConversationTypeMask(
        resolveNarrowedConversationTypeMask(
          workspaceConversationTypeMask,
          exposure.conversation_type_mask_override,
        ),
        existing.conversation_type_mask_override,
      ),
    });
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
         subject_workspace_member_id,
         subject_actor_id,
         subject_conversation_id,
         subject_conversation_actor_context_id,
         conversation_type_mask_override,
         granted_permissions,
         status,
         created_by_workspace_member_id,
         reason,
         metadata
       )
       VALUES (
        $1, 'relay_exposure', $2, $3, $4, $5, $6, $7, $8, $9, $10, ARRAY['invoke']::text[], 'active', $11, $12, $13::jsonb
       )
       RETURNING *`,
      [
        input.workspaceId,
        input.exposureId,
        target.targetType,
        target.relation,
        target.subjectWorkspaceId,
        target.subjectWorkspaceMemberId,
        target.subjectActorId,
        target.subjectConversationId,
        target.subjectConversationActorContextId,
        input.conversationTypeMaskOverride ?? null,
        input.grantedByWorkspaceMemberId || null,
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
  return mapAccessBindingToGrant({
    ...inserted.binding,
    subject_actor_id: target.subjectActorId,
    subject_conversation_id: target.subjectConversationId,
    subject_conversation_actor_context_id:
      target.subjectConversationActorContextId,
  } as AccessBindingRow, ["invoke"], undefined, {
    effectiveConversationTypeMask: resolveNarrowedConversationTypeMask(
      resolveNarrowedConversationTypeMask(
        workspaceConversationTypeMask,
        exposure.conversation_type_mask_override,
      ),
      input.conversationTypeMaskOverride,
    ),
  });
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

export async function updateRelayExposurePolicy(input: {
  workspaceId: string;
  exposureId: string;
  conversationTypeMaskOverride?: number | null;
}) {
  if (input.conversationTypeMaskOverride === undefined) {
    return;
  }

  await executeSql(
    `UPDATE relay_exposures exposure
     SET conversation_type_mask_override = $3,
         updated_at = NOW()
     FROM relay_devices device
     WHERE exposure.id = $1
       AND exposure.device_id = device.id
       AND device.workspace_id = $2`,
    [input.exposureId, input.workspaceId, input.conversationTypeMaskOverride],
  );

  await incrementMcpVersion(input.workspaceId);
}

export async function updateRelayExposureAccessGrant(input: {
  workspaceId: string;
  exposureId: string;
  bindingId: string;
  conversationTypeMaskOverride?: number | null;
}) {
  const exposure = await loadRelayExposurePolicyState(
    input.workspaceId,
    input.exposureId,
  );
  if (!exposure) {
    const error = new Error("Relay exposure not found") as Error & { code: string };
    error.code = "RELAY_EXPOSURE_NOT_FOUND";
    throw error;
  }

  const existing = (await listRelayExposureAccessRows(
    input.workspaceId,
    input.exposureId,
    true,
  )).find((row) => row.id === input.bindingId);
  if (!existing) {
    const error = new Error("Relay exposure access binding not found") as Error & {
      code: string;
    };
    error.code = "RELAY_EXPOSURE_ACCESS_NOT_FOUND";
    throw error;
  }

  if (input.conversationTypeMaskOverride !== undefined) {
    await executeSql(
      `UPDATE access_bindings
       SET conversation_type_mask_override = $2
       WHERE id = $1
         AND workspace_id = $3`,
      [input.bindingId, input.conversationTypeMaskOverride, input.workspaceId],
    );
  }

  const updated = (await listRelayExposureAccessRows(
    input.workspaceId,
    input.exposureId,
  )).find((row) => row.id === input.bindingId);
  if (!updated) {
    const error = new Error("Relay exposure access binding not found") as Error & {
      code: string;
    };
    error.code = "RELAY_EXPOSURE_ACCESS_NOT_FOUND";
    throw error;
  }

  const workspaceConversationTypeMask =
    await getWorkspaceCapabilityConversationTypeMask(
      exposure.owner_workspace_id,
      "relay_exposure",
    );

  return mapAccessBindingToGrant(updated, ["invoke"], undefined, {
    effectiveConversationTypeMask: resolveNarrowedConversationTypeMask(
      resolveNarrowedConversationTypeMask(
        workspaceConversationTypeMask,
        exposure.conversation_type_mask_override,
      ),
      updated.conversation_type_mask_override,
    ),
  });
}

export async function revokeRelayDeviceAuthzState(input: {
  workspaceId: string;
  deviceId: string;
  ownerWorkspaceMemberId?: string | null;
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
          ownerWorkspaceMemberId: input.ownerWorkspaceMemberId,
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
