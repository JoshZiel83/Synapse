import type pg from "pg"
import type { CapabilityAccessTarget } from "@synapse/shared/types"
import { transaction } from "../../infrastructure/database/index.js"
import {
  db,
  executeSql,
  executeSqlOn,
  executeTakeFirst,
} from "../../infrastructure/database/kysely.js"
import {
  accessBindingHasTarget,
  mapAccessBindingToGrant,
  normalizeAccessBindingRow,
  resolveAccessGrantTarget,
  type AccessBindingRow,
} from "../access/bindings.js"
import { buildResourceAccessBindingInsertValues } from "../access/binding-storage.js"
import {
  assertConversationTypeMaskWithinParent,
  assertGrantConversationTypeOverrideAllowed,
  validateConversationScopedAccessTarget,
} from "../access/conversation-type-validation.js"
import { getWorkspaceCapabilityConversationTypeMask } from "../capabilities/conversation-type-policies.js"
import {
  resolveRelayCapabilityConversationTypeMask,
  resolveRelayDeviceConversationTypeMask,
  resolveRelayGrantConversationTypeMask,
} from "./relay-policy.js"
import { incrementMcpVersion } from "./runtime-version.js"

type Queryable = Pick<pg.PoolClient, "query">

const RELAY_CAPABILITY_PERMISSION_SUMMARY = {
  requiredPermissions: ["use"],
  suggestedAccessTargetType: "workspace" as const,
  reason:
    "Relay capability access controls who can use tools from this relay exposure.",
}

function buildRelayGrantPolicyError(code: string, message: string) {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

async function loadRelayExposurePolicyState(
  workspaceId: string,
  exposureId: string
) {
  const result = await executeSql<{
    id: string
    capability_id: string
    owner_workspace_id: string
    device_conversation_type_mask_override: number | null
    capability_conversation_type_mask_override: number | null
  }>(
    `SELECT
       e.id,
       capability.id AS capability_id,
       d.workspace_id AS owner_workspace_id,
       d.conversation_type_mask_override AS device_conversation_type_mask_override,
       capability.conversation_type_mask_override AS capability_conversation_type_mask_override
     FROM relay_exposures e
     INNER JOIN relay_devices d
       ON d.id = e.device_id
     INNER JOIN relay_capabilities capability
       ON capability.exposure_id = e.id
     WHERE e.id = $1
       AND d.workspace_id = $2
     LIMIT 1`,
    [exposureId, workspaceId]
  )

  return result.rows[0] || null
}

function resolveRelayExposurePolicyMasks(params: {
  workspaceConversationTypeMask: number
  deviceConversationTypeMaskOverride?: number | null
  capabilityConversationTypeMaskOverride?: number | null
}) {
  const parentConversationTypeMask = resolveRelayDeviceConversationTypeMask(
    params.workspaceConversationTypeMask,
    params.deviceConversationTypeMaskOverride
  )
  const effectiveConversationTypeMask =
    resolveRelayCapabilityConversationTypeMask(
      parentConversationTypeMask,
      params.capabilityConversationTypeMaskOverride
    )
  return {
    parentConversationTypeMask,
    effectiveConversationTypeMask,
  }
}

async function listRelayExposureAccessRows(
  workspaceId: string,
  capabilityId: string,
  includeRevoked = false
) {
  const result = await executeSql<AccessBindingRow>(
    `SELECT
       binding.id,
       binding.workspace_id,
       binding.resource_type,
       binding.installed_skill_id,
       binding.plugin_installation_id,
       binding.relay_capability_id,
       binding.relay_capability_id::text AS resource_id,
       binding.target_type,
       binding.subject_workspace_id,
       COALESCE(binding.subject_actor_id, cac.actor_id) AS subject_actor_id,
       COALESCE(binding.subject_conversation_id, cac.conversation_id) AS subject_conversation_id,
       binding.subject_conversation_actor_context_id,
       binding.conversation_type_mask_override,
       binding.status,
       binding.created_by_workspace_member_id,
       binding.reason,
       binding.created_at,
       binding.revoked_at
     FROM resource_access_bindings binding
     LEFT JOIN conversation_actor_contexts cac
       ON cac.id = binding.subject_conversation_actor_context_id
     WHERE binding.workspace_id = $1
       AND binding.relay_capability_id = $2::uuid
       ${includeRevoked ? "" : "AND binding.status = 'active'"}
     ORDER BY binding.created_at ASC`,
    [workspaceId, capabilityId]
  )
  return result.rows.map((row) => normalizeAccessBindingRow(row))
}

export async function ensureRelayExposureDefaultAccess(params: {
  workspaceId: string
  capabilityId: string
}) {
  await transaction(async (client) => {
    const existing = await executeSqlOn<{ id: string }>(
      client,
      `SELECT id
       FROM resource_access_bindings
       WHERE relay_capability_id = $1::uuid
       LIMIT 1`,
      [params.capabilityId]
    )

    if (existing.rows.length > 0) {
      return
    }

    await executeSqlOn<AccessBindingRow>(
      client,
      `INSERT INTO resource_access_bindings (
         workspace_id,
         resource_type,
         relay_capability_id,
         target_type,
         subject_workspace_id,
         subject_actor_id,
         subject_conversation_id,
         status,
         reason
       )
       VALUES (
        $1, 'relay_capability', $2, 'workspace', $3, NULL, NULL, 'active', $4
       )
       RETURNING *, relay_capability_id::text AS resource_id`,
      [
        params.workspaceId,
        params.capabilityId,
        params.workspaceId,
        RELAY_CAPABILITY_PERMISSION_SUMMARY.reason,
      ]
    )
  })
}

export async function touchRelayExposureAccessState(params: {
  workspaceId: string
  deviceId: string
  exposureId: string
}) {
  await transaction(async (client) => {
    await executeSqlOn<{ id: string }>(
      client,
      `INSERT INTO relay_capabilities (
         workspace_id,
         exposure_id,
         status
       )
       VALUES ($1, $2, 'active')
       ON CONFLICT (exposure_id) DO UPDATE
         SET workspace_id = EXCLUDED.workspace_id,
             status = 'active',
             updated_at = NOW()
       RETURNING id`,
      [params.workspaceId, params.exposureId]
    )
  })
  const state = await loadRelayExposurePolicyState(
    params.workspaceId,
    params.exposureId
  )
  if (!state) {
    throw new Error("Relay capability was not created for exposure")
  }
  await ensureRelayExposureDefaultAccess({
    workspaceId: params.workspaceId,
    capabilityId: state.capability_id,
  })
}

export async function listRelayExposureAccessState(
  workspaceId: string,
  exposureId: string
) {
  const exposure = await loadRelayExposurePolicyState(workspaceId, exposureId)
  if (!exposure) {
    const error = new Error("Relay exposure not found") as Error & {
      code: string
    }
    error.code = "RELAY_EXPOSURE_NOT_FOUND"
    throw error
  }
  const workspaceConversationTypeMask =
    await getWorkspaceCapabilityConversationTypeMask(
      exposure.owner_workspace_id,
      "relay_capability"
    )
  const { parentConversationTypeMask, effectiveConversationTypeMask } =
    resolveRelayExposurePolicyMasks({
      workspaceConversationTypeMask,
      deviceConversationTypeMaskOverride:
        exposure.device_conversation_type_mask_override,
      capabilityConversationTypeMaskOverride:
        exposure.capability_conversation_type_mask_override,
    })
  const grants = (
    await listRelayExposureAccessRows(workspaceId, exposure.capability_id)
  ).map((row) =>
    mapAccessBindingToGrant(row, ["use"], undefined, {
      effectiveConversationTypeMask: resolveRelayGrantConversationTypeMask(
        effectiveConversationTypeMask,
        row.conversation_type_mask_override
      ),
    })
  )
  return {
    grants,
    summary: {
      ...RELAY_CAPABILITY_PERMISSION_SUMMARY,
      workspaceConversationTypeMask,
      parentConversationTypeMask,
      parentPolicyLabel: "device",
      capabilityId: exposure.capability_id,
      conversationTypeMaskOverride:
        exposure.capability_conversation_type_mask_override ?? null,
      effectiveConversationTypeMask,
      effectivePermissions: grants.length > 0 ? ["use"] : [],
      isVisible: grants.length > 0,
      isAuthorized: grants.length > 0,
      matchingGrantIds: grants.map((grant) => grant.id),
    },
  }
}

export async function grantRelayExposureAccess(input: {
  workspaceId: string
  exposureId: string
  accessTarget?: CapabilityAccessTarget
  conversationTypeMaskOverride?: number | null
  grantedByWorkspaceMemberId?: string
  reason?: string
}) {
  const exposure = await loadRelayExposurePolicyState(
    input.workspaceId,
    input.exposureId
  )
  if (!exposure) {
    const error = new Error("Relay exposure not found") as Error & {
      code: string
    }
    error.code = "RELAY_EXPOSURE_NOT_FOUND"
    throw error
  }
  const workspaceConversationTypeMask =
    await getWorkspaceCapabilityConversationTypeMask(
      exposure.owner_workspace_id,
      "relay_capability"
    )
  const { effectiveConversationTypeMask } = resolveRelayExposurePolicyMasks({
    workspaceConversationTypeMask,
    deviceConversationTypeMaskOverride:
      exposure.device_conversation_type_mask_override,
    capabilityConversationTypeMaskOverride:
      exposure.capability_conversation_type_mask_override,
  })
  const target = await resolveAccessGrantTarget({
    workspaceId: input.workspaceId,
    target: input.accessTarget || { type: "workspace" },
  })
  assertGrantConversationTypeOverrideAllowed({
    targetType: target.targetType,
    parentConversationTypeMask: effectiveConversationTypeMask,
    conversationTypeMaskOverride: input.conversationTypeMaskOverride,
    buildError: (message) =>
      buildRelayGrantPolicyError(
        "RELAY_EXPOSURE_GRANT_CONVERSATION_POLICY_INVALID",
        message
      ),
    invalidMaskMessage:
      "Relay exposure grant conversation policy must allow at least one conversation type from the exposure policy.",
  })
  await validateConversationScopedAccessTarget({
    targetType: target.targetType,
    conversationId: target.subjectConversationId,
    actorId: target.subjectActorId,
    effectiveConversationTypeMask,
    buildError: (message) =>
      buildRelayGrantPolicyError(
        "RELAY_EXPOSURE_GRANT_CONVERSATION_POLICY_INVALID",
        message
      ),
  })

  const existing = (
    await listRelayExposureAccessRows(input.workspaceId, exposure.capability_id)
  ).find((row) => accessBindingHasTarget(row, target))

  if (existing) {
    return mapAccessBindingToGrant(existing, ["use"], undefined, {
      effectiveConversationTypeMask: resolveRelayGrantConversationTypeMask(
        effectiveConversationTypeMask,
        existing.conversation_type_mask_override
      ),
    })
  }
  const inserted = await transaction(async (client) => {
    const binding = await executeTakeFirst<AccessBindingRow>(
      client,
      db
        .insertInto("resource_access_bindings")
        .values(
          buildResourceAccessBindingInsertValues({
            workspaceId: input.workspaceId,
            resourceType: "relay_capability",
            resourceId: exposure.capability_id,
            target,
            conversationTypeMaskOverride:
              input.conversationTypeMaskOverride ?? null,
            createdByWorkspaceMemberId:
              input.grantedByWorkspaceMemberId || null,
            reason: input.reason || RELAY_CAPABILITY_PERMISSION_SUMMARY.reason,
          })
        )
        .returningAll()
    )
    if (!binding) {
      throw new Error("Failed to create relay capability access binding")
    }

    return {
      binding: {
        ...binding,
        resource_id: binding.relay_capability_id!,
      } as AccessBindingRow,
    }
  })

  await incrementMcpVersion(input.workspaceId)
  return mapAccessBindingToGrant(
    {
      ...normalizeAccessBindingRow(inserted.binding),
      subject_actor_id: target.subjectActorId,
      subject_conversation_id: target.subjectConversationId,
      subject_conversation_actor_context_id:
        target.subjectConversationActorContextId,
    } as AccessBindingRow,
    ["use"],
    undefined,
    {
      effectiveConversationTypeMask: resolveRelayGrantConversationTypeMask(
        effectiveConversationTypeMask,
        input.conversationTypeMaskOverride
      ),
    }
  )
}

export async function revokeRelayExposureAccess(input: {
  workspaceId: string
  exposureId: string
  bindingId: string
}) {
  const result = await executeSql<AccessBindingRow>(
    `SELECT *, relay_capability_id::text AS resource_id
     FROM resource_access_bindings
     WHERE id = $1
       AND workspace_id = $2
       AND relay_capability_id = (
         SELECT capability.id
         FROM relay_capabilities capability
         WHERE capability.exposure_id = $3
         LIMIT 1
       )
     LIMIT 1`,
    [input.bindingId, input.workspaceId, input.exposureId]
  )

  if (result.rows.length === 0) {
    const error = new Error(
      "Relay exposure access binding not found"
    ) as Error & {
      code: string
    }
    error.code = "RELAY_EXPOSURE_ACCESS_NOT_FOUND"
    throw error
  }

  const binding = normalizeAccessBindingRow(result.rows[0]!)
  await transaction(async (client) => {
    await executeSqlOn(
      client,
      `UPDATE resource_access_bindings
       SET status = 'revoked',
           revoked_at = NOW()
       WHERE id = $1`,
      [binding.id]
    )
  })

  await incrementMcpVersion(input.workspaceId)
}

export async function updateRelayExposurePolicy(input: {
  workspaceId: string
  exposureId: string
  conversationTypeMaskOverride?: number | null
}) {
  if (input.conversationTypeMaskOverride === undefined) {
    return
  }

  const exposure = await loadRelayExposurePolicyState(
    input.workspaceId,
    input.exposureId
  )
  if (!exposure) {
    const error = new Error("Relay exposure not found") as Error & {
      code: string
    }
    error.code = "RELAY_EXPOSURE_NOT_FOUND"
    throw error
  }

  const workspaceConversationTypeMask =
    await getWorkspaceCapabilityConversationTypeMask(
      exposure.owner_workspace_id,
      "relay_capability"
    )
  const parentConversationTypeMask = resolveRelayDeviceConversationTypeMask(
    workspaceConversationTypeMask,
    exposure.device_conversation_type_mask_override
  )
  const nextEffectiveConversationTypeMask =
    assertConversationTypeMaskWithinParent({
      parentConversationTypeMask,
      conversationTypeMaskOverride: input.conversationTypeMaskOverride,
      buildError: (message) =>
        buildRelayGrantPolicyError(
          "RELAY_EXPOSURE_CONVERSATION_POLICY_INVALID",
          message
        ),
      invalidMaskMessage:
        "Relay exposure conversation policy must allow at least one conversation type from the device policy.",
    })
  const accessRows = await listRelayExposureAccessRows(
    input.workspaceId,
    exposure.capability_id
  )
  for (const accessRow of accessRows) {
    await validateConversationScopedAccessTarget({
      targetType: accessRow.target_type,
      conversationId: accessRow.subject_conversation_id,
      actorId: accessRow.subject_actor_id,
      effectiveConversationTypeMask: nextEffectiveConversationTypeMask,
      buildError: (message) =>
        buildRelayGrantPolicyError(
          "RELAY_EXPOSURE_CONVERSATION_POLICY_INVALID",
          message
        ),
    })
  }

  await executeSql(
    `UPDATE relay_capabilities capability
     SET conversation_type_mask_override = $3,
         updated_at = NOW()
     FROM relay_exposures exposure
     JOIN relay_devices device
       ON device.id = exposure.device_id
     WHERE capability.exposure_id = exposure.id
       AND exposure.id = $1
       AND device.workspace_id = $2`,
    [input.exposureId, input.workspaceId, input.conversationTypeMaskOverride]
  )

  await incrementMcpVersion(input.workspaceId)
}

export async function updateRelayExposureAccessGrant(input: {
  workspaceId: string
  exposureId: string
  bindingId: string
  conversationTypeMaskOverride?: number | null
}) {
  const exposure = await loadRelayExposurePolicyState(
    input.workspaceId,
    input.exposureId
  )
  if (!exposure) {
    const error = new Error("Relay exposure not found") as Error & {
      code: string
    }
    error.code = "RELAY_EXPOSURE_NOT_FOUND"
    throw error
  }

  const existing = (
    await listRelayExposureAccessRows(
      input.workspaceId,
      exposure.capability_id,
      true
    )
  ).find((row) => row.id === input.bindingId)
  if (!existing) {
    const error = new Error(
      "Relay exposure access binding not found"
    ) as Error & {
      code: string
    }
    error.code = "RELAY_EXPOSURE_ACCESS_NOT_FOUND"
    throw error
  }

  const workspaceConversationTypeMask =
    await getWorkspaceCapabilityConversationTypeMask(
      exposure.owner_workspace_id,
      "relay_capability"
    )
  const { effectiveConversationTypeMask } = resolveRelayExposurePolicyMasks({
    workspaceConversationTypeMask,
    deviceConversationTypeMaskOverride:
      exposure.device_conversation_type_mask_override,
    capabilityConversationTypeMaskOverride:
      exposure.capability_conversation_type_mask_override,
  })

  if (input.conversationTypeMaskOverride !== undefined) {
    assertGrantConversationTypeOverrideAllowed({
      targetType: existing.target_type,
      parentConversationTypeMask: effectiveConversationTypeMask,
      conversationTypeMaskOverride: input.conversationTypeMaskOverride,
      buildError: (message) =>
        buildRelayGrantPolicyError(
          "RELAY_EXPOSURE_GRANT_CONVERSATION_POLICY_INVALID",
          message
        ),
      invalidMaskMessage:
        "Relay exposure grant conversation policy must allow at least one conversation type from the exposure policy.",
    })
    await validateConversationScopedAccessTarget({
      targetType: existing.target_type,
      conversationId: existing.subject_conversation_id,
      actorId: existing.subject_actor_id,
      effectiveConversationTypeMask,
      buildError: (message) =>
        buildRelayGrantPolicyError(
          "RELAY_EXPOSURE_GRANT_CONVERSATION_POLICY_INVALID",
          message
        ),
    })
  }

  if (input.conversationTypeMaskOverride !== undefined) {
    await executeSql(
      `UPDATE resource_access_bindings
       SET conversation_type_mask_override = $2
       WHERE id = $1
         AND workspace_id = $3`,
      [input.bindingId, input.conversationTypeMaskOverride, input.workspaceId]
    )
  }

  const updated = (
    await listRelayExposureAccessRows(input.workspaceId, exposure.capability_id)
  ).find((row) => row.id === input.bindingId)
  if (!updated) {
    const error = new Error(
      "Relay exposure access binding not found"
    ) as Error & {
      code: string
    }
    error.code = "RELAY_EXPOSURE_ACCESS_NOT_FOUND"
    throw error
  }

  return mapAccessBindingToGrant(updated, ["use"], undefined, {
    effectiveConversationTypeMask: resolveRelayGrantConversationTypeMask(
      effectiveConversationTypeMask,
      updated.conversation_type_mask_override
    ),
  })
}

export async function revokeRelayDeviceAccessState(input: {
  workspaceId: string
  deviceId: string
  ownerWorkspaceMemberId?: string | null
  exposureIds: string[]
}) {
  const activeBindings =
    input.exposureIds.length > 0
      ? await executeSql<AccessBindingRow>(
          `SELECT *, relay_capability_id::text AS resource_id
         FROM resource_access_bindings
         WHERE workspace_id = $1
           AND relay_capability_id IN (
             SELECT id FROM relay_capabilities WHERE exposure_id = ANY($2::uuid[])
           )
           AND status = 'active'`,
          [input.workspaceId, input.exposureIds]
        )
      : { rows: [] as AccessBindingRow[] }

  await transaction(async (client) => {
    if (activeBindings.rows.length > 0) {
      await executeSqlOn(
        client,
        `UPDATE resource_access_bindings
         SET status = 'revoked',
             revoked_at = NOW()
         WHERE id = ANY($1::uuid[])`,
        [activeBindings.rows.map((row) => row.id)]
      )
    }
  })
}
