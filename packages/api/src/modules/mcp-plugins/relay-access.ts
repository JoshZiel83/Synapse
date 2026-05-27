import type pg from "pg"
import type { CapabilityAccessTarget } from "@synapse/shared/types"
import {
  actorRef,
  conversationRef,
  remoteAgentRef,
  subjectScopeLabel,
  workspaceMemberRef,
  workspaceRef,
} from "@synapse/shared"
import { transaction } from "../../infrastructure/database/index.js"
import {
  db,
  executeSql,
  executeSqlOn,
} from "../../infrastructure/database/kysely.js"
import {
  accessBindingHasTarget,
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
  reason:
    "Relay capability access controls who can use tools from this relay exposure.",
}

/**
 * D3: convert a stored AccessBindingRow into a ScopedSubjectTarget for handing
 * to policy / grant helpers. This wraps `readAccessBindingTarget` so callers
 * with row-shaped rows from binding-storage's bindingRowSelectFor can recover
 * the target without re-implementing the projection.
 *
 * Post-D4 round 8 review (P3): added `remote_agent` to the subject_kind
 * switch. Previously remote_agent rows fell through to the
 * `default: workspace` fallback, so relay policy updates re-validated
 * existing remote-agent scoped grants against the wrong target —
 * conversation-type policy was evaluated for a "workspace" instead of
 * the actual remote_agent + scope=conversation shape, and any subject-
 * specific checks downstream silently misidentified the binding.
 */
function relayBindingRowToTarget(
  row: AccessBindingRow & {
    subject_kind?: string | null
    subject_workspace_id_via_join?: string | null
    subject_workspace_member_id_via_join?: string | null
    subject_actor_id_via_join?: string | null
    subject_remote_agent_id_via_join?: string | null
    subject_conversation_id_via_join?: string | null
    scope_kind?: string | null
    scope_workspace_id_via_join?: string | null
    scope_conversation_id_via_join?: string | null
  }
): CapabilityAccessTarget {
  // Decode the projection — the bindingRowSelectFor JOIN-aliased fields carry
  // the data needed to reconstruct subject/scope.
  const subjectKind = row.subject_kind
  if (!subjectKind) {
    // Fallback: use the workspace as principal so callers don't crash.
    return { subject: workspaceRef(row.workspace_id) }
  }
  let subject
  switch (subjectKind) {
    case "workspace":
      subject = workspaceRef(
        row.subject_workspace_id_via_join || row.workspace_id
      )
      break
    case "workspace_member":
      subject = row.subject_workspace_member_id_via_join
        ? workspaceMemberRef(row.subject_workspace_member_id_via_join)
        : workspaceRef(row.workspace_id)
      break
    case "actor":
      subject = row.subject_actor_id_via_join
        ? actorRef(row.subject_actor_id_via_join)
        : workspaceRef(row.workspace_id)
      break
    case "remote_agent":
      subject = row.subject_remote_agent_id_via_join
        ? remoteAgentRef(row.subject_remote_agent_id_via_join)
        : workspaceRef(row.workspace_id)
      break
    case "conversation":
      subject = row.subject_conversation_id_via_join
        ? conversationRef(row.subject_conversation_id_via_join)
        : workspaceRef(row.workspace_id)
      break
    default:
      subject = workspaceRef(row.workspace_id)
  }
  const scopeKind = row.scope_kind
  if (scopeKind === "conversation" && row.scope_conversation_id_via_join) {
    return {
      subject,
      scope: conversationRef(row.scope_conversation_id_via_join),
    }
  }
  if (scopeKind === "workspace" && row.scope_workspace_id_via_join) {
    return {
      subject,
      scope: workspaceRef(row.scope_workspace_id_via_join),
    }
  }
  return { subject }
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
      target: { subject: workspaceRef(params.workspaceId) },
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
  const target = await resolveAccessGrantTarget({
    workspaceId: input.workspaceId,
    target: input.accessTarget || { subject: workspaceRef(input.workspaceId) },
  })
  assertGrantConversationTypeOverrideAllowed({
    target,
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
    target,
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
      target: relayBindingRowToTarget(accessRow as any),
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
    const existingTarget = relayBindingRowToTarget(existing as any)
    assertGrantConversationTypeOverrideAllowed({
      target: existingTarget,
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
      target: existingTarget,
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
