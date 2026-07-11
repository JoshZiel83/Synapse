// Device capability aggregator for capability-projection. Loads device-side
// tools that an actor / conversation has access to via workspace_resource_grants
// (subject_id → access_subjects → workspace_resource_id=runtime_capability id).
//
// v3.0 ships the read path; PR #8 wires the write path UI for group chat.
//
// round-6 P1-6: all db-client access now lives in ./repo.ts (guard r8). This
// file is the orchestration / DTO layer — it resolves AccessTarget DTOs to
// subject ids and calls the repo helpers. The public function names and the
// `DeviceCapabilityToolRow` / `AccessTargetInput` types are re-exported here so
// external importers (index.ts `export *`, sandbox/grants.ts,
// devices/access-bindings.ts, service.ts, tests) need no changes.

import type { Executor } from "../../infrastructure/database/kysely.js"
import {
  selectDeviceCapabilityToolsForSubjects,
  resolveScopedSubjectTarget,
  replaceDeviceCapabilityGrants,
  insertDeviceCapabilityGrants,
  revokeDeviceCapabilityGrants,
  selectActiveDeviceCapabilityIdsForSubject,
  type DeviceCapabilityToolRow,
  type LoadDeviceToolsParams,
  type AccessTargetInput,
} from "./repo.js"

export type {
  DeviceCapabilityToolRow,
  LoadDeviceToolsParams,
  AccessTargetInput,
}
export { resolveScopedSubjectTarget }

export async function loadDeviceCapabilityToolsForSubjects(
  params: LoadDeviceToolsParams
): Promise<DeviceCapabilityToolRow[]> {
  return selectDeviceCapabilityToolsForSubjects(params)
}

/**
 * @deprecated Use `resolveScopedSubjectTarget` so callers can write
 * `scope_subject_id` properly. Returning just the subject_id silently drops
 * the scope dimension.
 */
export async function resolveAccessTargetSubjectId(
  input: AccessTargetInput
): Promise<string> {
  const resolved = await resolveScopedSubjectTarget(input)
  return resolved.subjectId
}

export interface SetActiveDeviceCapabilitiesParams {
  workspaceId: string
  target: AccessTargetInput
  deviceCapabilityIds: string[]
  createdByWorkspaceMemberId?: string | null
  reason?: string
}

export async function setActiveDeviceCapabilitiesForTarget(
  params: SetActiveDeviceCapabilitiesParams
): Promise<void> {
  const { subjectId, scopeSubjectId } = await resolveScopedSubjectTarget(
    params.target
  )
  await replaceDeviceCapabilityGrants({
    workspaceId: params.workspaceId,
    subjectId,
    scopeSubjectId,
    capabilityIds: params.deviceCapabilityIds,
    createdByWorkspaceMemberId: params.createdByWorkspaceMemberId,
    reason: params.reason,
  })
}

export async function listActiveDeviceCapabilitiesForTarget(params: {
  workspaceId: string
  target: AccessTargetInput
}): Promise<string[]> {
  const { subjectId, scopeSubjectId } = await resolveScopedSubjectTarget(
    params.target
  )
  return selectActiveDeviceCapabilityIdsForSubject(
    params.workspaceId,
    subjectId,
    scopeSubjectId
  )
}

/**
 * ADDITIVE capability grant: activate bindings for exactly the given capability
 * ids on (subject, scope), WITHOUT touching the target's other capability
 * bindings. Unlike setActiveDeviceCapabilitiesForTarget (a full replace), this
 * is safe when several independent grantors (e.g. a sandbox provision + a
 * manually-granted device capability) coexist on the same actor/conversation.
 * Idempotent per (capability, subject, scope) via the active partial-unique.
 */
export async function addDeviceCapabilitiesForTarget(
  params: SetActiveDeviceCapabilitiesParams,
  options?: { db?: Executor }
): Promise<void> {
  if (params.deviceCapabilityIds.length === 0) return
  const { subjectId, scopeSubjectId } = await resolveScopedSubjectTarget(
    params.target,
    { db: options?.db }
  )
  await insertDeviceCapabilityGrants(
    {
      workspaceId: params.workspaceId,
      subjectId,
      scopeSubjectId,
      capabilityIds: params.deviceCapabilityIds,
      createdByWorkspaceMemberId: params.createdByWorkspaceMemberId,
      reason: params.reason,
    },
    options?.db
  )
}

/**
 * TARGETED capability revoke: revoke ONLY the given capability ids' active
 * bindings on (subject, scope), leaving the target's other capabilities intact.
 * The inverse of addDeviceCapabilitiesForTarget — used at sandbox teardown so we
 * don't clobber an unrelated manual grant on the same actor/conversation.
 */
export async function revokeDeviceCapabilitiesForTarget(
  params: SetActiveDeviceCapabilitiesParams,
  options?: { db?: Executor }
): Promise<void> {
  if (params.deviceCapabilityIds.length === 0) return
  const { subjectId, scopeSubjectId } = await resolveScopedSubjectTarget(
    params.target,
    { db: options?.db }
  )
  await revokeDeviceCapabilityGrants(
    {
      workspaceId: params.workspaceId,
      subjectId,
      scopeSubjectId,
      capabilityIds: params.deviceCapabilityIds,
      createdByWorkspaceMemberId: params.createdByWorkspaceMemberId,
      reason: params.reason,
    },
    options?.db
  )
}
