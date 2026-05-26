import type pg from "pg"
import type { CapabilityAccessTarget } from "@synapse/shared/types"
import { transaction } from "../../infrastructure/database/index.js"
import {
  db,
  executeSql,
  executeSqlOn,
} from "../../infrastructure/database/kysely.js"
import {
  accessBindingHasTarget,
  assertLegacyTargetType,
  mapAccessBindingToGrant,
  normalizeAccessBindingRow,
  type AccessBindingRow,
} from "../access/bindings.js"
import { resolveAccessGrantTarget } from "../access/access-target-resolver.js"
import {
  hasAnyBindingForResourceOn,
  insertAccessBindingReturningIdOn,
  insertAccessBindingReturningRowOn,
  loadAccessBindingRowsForResource,
  loadAccessBindingRowsForResources,
  revokeGrant,
  revokeGrantsByIdsOn,
  updateGrantConversationTypeMaskOverride,
} from "../access/binding-storage.js"
import {
  assertConversationTypeMaskWithinParent,
  assertGrantConversationTypeOverrideAllowed,
  validateConversationScopedAccessTarget,
} from "../access/policy.js"
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
  return loadAccessBindingRowsForResource(db, {
    resourceType: "relay_capability",
    resourceId: capabilityId,
    workspaceId,
    includeRevoked,
  })
}

export async function ensureRelayExposureDefaultAccess(params: {
  workspaceId: string
  capabilityId: string
}) {
  await transaction(async (client) => {
    const alreadyHasBinding = await hasAnyBindingForResourceOn(client, {
      resourceType: "relay_capability",
      resourceId: params.capabilityId,
    })
    if (alreadyHasBinding) {
      return
    }

    // P1b contract: use binding-storage helper which upserts access_subjects
    // and writes the new subject_id schema.
    await insertAccessBindingReturningIdOn(client, {
      workspaceId: params.workspaceId,
      resourceType: "relay_capability",
      resourceId: params.capabilityId,
      target: {
        targetType: "workspace",
        subjectWorkspaceId: params.workspaceId,
        subjectWorkspaceMemberId: null,
        subjectActorId: null,
        subjectConversationId: null,
        subjectConversationActorContextId: null,
      },
      source: "relay_auto",
      reason: RELAY_CAPABILITY_PERMISSION_SUMMARY.reason,
    })
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
    mapAccessBindingToGrant(row, undefined, {
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
  const targetResolved = await resolveAccessGrantTarget({
    workspaceId: input.workspaceId,
    target: input.accessTarget || { type: "workspace" },
  })
  // PR2: relay-access still on the legacy path. PR4 will widen this when
  // the relay-authorization rewrite makes scoped-subject grants first-class.
  if ("subject" in targetResolved) {
    throw buildRelayGrantPolicyError(
      "RELAY_EXPOSURE_GRANT_CONVERSATION_POLICY_INVALID",
      `Scoped-subject access grants are not yet supported here (subject.kind=${targetResolved.subject.kind}).`
    )
  }
  const target = targetResolved
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
    db,
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
    return mapAccessBindingToGrant(existing, undefined, {
      effectiveConversationTypeMask: resolveRelayGrantConversationTypeMask(
        effectiveConversationTypeMask,
        existing.conversation_type_mask_override
      ),
    })
  }
  const inserted = await transaction(async (client) => {
    const binding = await insertAccessBindingReturningRowOn(client, {
      workspaceId: input.workspaceId,
      resourceType: "relay_capability",
      resourceId: exposure.capability_id,
      target,
      conversationTypeMaskOverride: input.conversationTypeMaskOverride ?? null,
      createdByWorkspaceMemberId: input.grantedByWorkspaceMemberId || null,
      reason: input.reason || RELAY_CAPABILITY_PERMISSION_SUMMARY.reason,
    })

    return {
      binding: {
        ...binding,
        resource_id: binding.relay_capability_id!,
      } as AccessBindingRow,
    }
  })

  await incrementMcpVersion(input.workspaceId)
  return mapAccessBindingToGrant(
    normalizeAccessBindingRow(inserted.binding),
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
  const exposure = await loadRelayExposurePolicyState(
    input.workspaceId,
    input.exposureId
  )
  if (!exposure) {
    const error = new Error(
      "Relay exposure access binding not found"
    ) as Error & {
      code: string
    }
    error.code = "RELAY_EXPOSURE_ACCESS_NOT_FOUND"
    throw error
  }
  const candidates = await listRelayExposureAccessRows(
    input.workspaceId,
    exposure.capability_id,
    true
  )
  const existing = candidates.find((row) => row.id === input.bindingId)
  if (!existing) {
    const error = new Error(
      "Relay exposure access binding not found"
    ) as Error & {
      code: string
    }
    error.code = "RELAY_EXPOSURE_ACCESS_NOT_FOUND"
    throw error
  }

  await revokeGrant(db, { bindingId: existing.id })

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
      db,
      targetType: assertLegacyTargetType(accessRow.target_type),
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
      targetType: assertLegacyTargetType(existing.target_type),
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
      db,
      targetType: assertLegacyTargetType(existing.target_type),
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
    await updateGrantConversationTypeMaskOverride(db, {
      bindingId: input.bindingId,
      workspaceId: input.workspaceId,
      conversationTypeMaskOverride: input.conversationTypeMaskOverride,
    })
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

  return mapAccessBindingToGrant(updated, undefined, {
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
  if (input.exposureIds.length === 0) {
    return
  }
  // Resolve the exposures' capability ids first (resource_access_bindings
  // hangs off relay_capability_id, not exposure_id).
  const capabilityRows = await db
    .selectFrom("relay_capabilities")
    .select("id")
    .where("exposure_id", "in", input.exposureIds)
    .execute()
  const capabilityIds = capabilityRows.map((row) => row.id as string)
  if (capabilityIds.length === 0) return

  const activeBindings = await loadAccessBindingRowsForResources(db, {
    resourceType: "relay_capability",
    resourceIds: capabilityIds,
    workspaceId: input.workspaceId,
  })

  await transaction(async (client) => {
    await revokeGrantsByIdsOn(
      client,
      activeBindings.map((row) => row.id)
    )
  })
}
