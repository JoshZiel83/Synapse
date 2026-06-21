// CLI-Anything grant reconciliation (plan §4.3 / P3).
//
// After a device's catalog sync persists its builtin/commandline exposure
// metadata.availableClis, we reconcile the TWO authz layers a CLI needs to be
// usable, mirroring createSandboxGrants but with subject=workspace (no
// conversation) and one program_only Layer-2 grant per available CLI:
//
//   Layer 1 — capability binding (workspace_resource_grants, permission 'use')
//     on the device's commandline capability for the WORKSPACE subject, so the
//     exec_file tool is surfaced. Idempotent (insertDeviceCapabilityGrants does
//     onConflict doNothing). The capability ROOT was created by the catalog-sync
//     ensureCapability with createdByPlatform:true.
//   Layer 2 — one program_only runtime grant per available entry_point
//     (program=entryPoint, any argv), gated server-side at mint against the same
//     availableClis (runtime-authorizations §5.C).
//
// Idempotent + self-healing: run on every catalog sync. Grants are minted only
// for CLIs not already granted (skip-if-exists, since runtime_authorization_grants
// has no unique index), and Layer-2 grants for CLIs that flipped to unavailable
// are revoked. Called best-effort after the sync response; a failure is retried
// on the next sync.

import {
  workspaceRef,
  type SharedRuntimeAuthorizationGrantSpec,
} from "@synapse/shared"
import { addDeviceCapabilitiesForTarget } from "../capability-projection/device-capabilities.js"
import {
  createRuntimeAuthorizationGrant,
  revokeRuntimeAuthorizationGrant,
} from "../runtime-authorizations/service.js"
import { selectActiveProgramOnlyCliGrants } from "../runtime-authorizations/repo.js"
import { selectDeviceCommandlineCliState } from "./repo.js"

export interface CliGrantReconcilePlan {
  /** entry_points to mint a program_only grant for (available + not yet granted). */
  toMint: string[]
  /** existing grants to revoke (a managed CLI that is no longer available). */
  toRevoke: { id: string; program: string }[]
}

/**
 * Pure reconcile-plan diff (unit-testable without a DB). Mint for available CLIs
 * not yet granted; revoke ONLY our managed-but-no-longer-available grants — a
 * program outside the device's managed set (e.g. an operator's manual grant) is
 * never swept. Skip-if-exists is the dedup since runtime_authorization_grants has
 * no unique index.
 */
export function computeCliGrantReconcilePlan(params: {
  availableEntryPoints: string[]
  managedEntryPoints: string[]
  existingGrants: { id: string; program: string }[]
}): CliGrantReconcilePlan {
  const available = new Set(params.availableEntryPoints)
  const managed = new Set(params.managedEntryPoints)
  const granted = new Set(params.existingGrants.map((g) => g.program))
  return {
    toMint: params.availableEntryPoints.filter((e) => !granted.has(e)),
    toRevoke: params.existingGrants.filter(
      (g) => managed.has(g.program) && !available.has(g.program)
    ),
  }
}

export async function reconcileDeviceCliGrants(
  deviceId: string
): Promise<void> {
  const state = await selectDeviceCommandlineCliState(deviceId)
  if (!state) return // no active commandline capability (not synced / no bwrap)
  const {
    workspaceId,
    exposureId,
    capabilityId,
    availableEntryPoints,
    managedEntryPoints,
  } = state

  const existing = await selectActiveProgramOnlyCliGrants(capabilityId)
  const plan = computeCliGrantReconcilePlan({
    availableEntryPoints,
    managedEntryPoints,
    existingGrants: existing,
  })

  // Revoke Layer-2 grants for managed CLIs that flipped to unavailable.
  for (const grant of plan.toRevoke) {
    await revokeRuntimeAuthorizationGrant(grant.id)
  }

  if (availableEntryPoints.length === 0) return

  // Layer 1 — bind the commandline capability to the workspace subject once
  // (additive + idempotent; 'use' permission set by insertDeviceCapabilityGrants).
  await addDeviceCapabilitiesForTarget({
    workspaceId,
    target: { kind: "workspace", workspaceId },
    deviceCapabilityIds: [capabilityId],
    reason: "cli-anything availability",
  })

  // Layer 2 — one program_only grant per available CLI (skip-if-exists).
  const subject = workspaceRef(workspaceId)
  for (const entryPoint of plan.toMint) {
    const policy: SharedRuntimeAuthorizationGrantSpec = {
      capability: "commandline",
      commandline: {
        executor: "exec_file",
        commandMatchType: "program_only",
        program: entryPoint,
      },
    }
    await createRuntimeAuthorizationGrant({
      workspaceId,
      deviceId,
      deviceCapabilityId: capabilityId,
      deviceExposureId: exposureId,
      subject,
      retention: "until_revoked",
      policy,
    })
  }
}
