// Runtime-capability aggregator for capability-projection. Loads runtime-side
// tools (real devices AND device-less sandbox runtimes) that an actor /
// conversation has access to via workspace_resource_grants
// (subject_id → access_subjects → workspace_resource_id=runtime_capability id).
//
// v3.0 ships the read path; PR #8 wires the write path UI for group chat.
//
// round-6 P1-6: all db-client access now lives in ./repo.ts (guard r8). This
// file is the orchestration / DTO layer — it resolves AccessTarget DTOs to
// subject ids and calls the repo helpers. The public function names and the
// `RuntimeCapabilityToolRow` / `AccessTargetInput` types are re-exported here so
// external importers (index.ts `export *`, sandbox/grants.ts,
// devices/access-bindings.ts, service.ts, tests) need no changes.

import type { Executor } from "../../infrastructure/database/kysely.js"
import {
  selectRuntimeCapabilityToolsForSubjects,
  resolveScopedSubjectTarget,
  replaceRuntimeCapabilityGrants,
  insertRuntimeCapabilityGrants,
  revokeRuntimeCapabilityGrants,
  selectActiveRuntimeCapabilityIdsForSubject,
  type RuntimeCapabilityToolRow,
  type LoadRuntimeToolsParams,
  type AccessTargetInput,
} from "./repo.js"

export type {
  RuntimeCapabilityToolRow,
  LoadRuntimeToolsParams,
  AccessTargetInput,
}
export { resolveScopedSubjectTarget }

export async function loadRuntimeCapabilityToolsForSubjects(
  params: LoadRuntimeToolsParams
): Promise<RuntimeCapabilityToolRow[]> {
  return selectRuntimeCapabilityToolsForSubjects(params)
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

export interface SetActiveRuntimeCapabilitiesParams {
  workspaceId: string
  target: AccessTargetInput
  runtimeCapabilityIds: string[]
  createdByWorkspaceMemberId?: string | null
  reason?: string
}

export async function setActiveRuntimeCapabilitiesForTarget(
  params: SetActiveRuntimeCapabilitiesParams
): Promise<void> {
  const { subjectId, scopeSubjectId } = await resolveScopedSubjectTarget(
    params.target
  )
  await replaceRuntimeCapabilityGrants({
    workspaceId: params.workspaceId,
    subjectId,
    scopeSubjectId,
    capabilityIds: params.runtimeCapabilityIds,
    createdByWorkspaceMemberId: params.createdByWorkspaceMemberId,
    reason: params.reason,
  })
}

export async function listActiveRuntimeCapabilitiesForTarget(params: {
  workspaceId: string
  target: AccessTargetInput
}): Promise<string[]> {
  const { subjectId, scopeSubjectId } = await resolveScopedSubjectTarget(
    params.target
  )
  return selectActiveRuntimeCapabilityIdsForSubject(
    params.workspaceId,
    subjectId,
    scopeSubjectId
  )
}

/**
 * ADDITIVE capability grant: activate bindings for exactly the given capability
 * ids on (subject, scope), WITHOUT touching the target's other capability
 * bindings. Unlike setActiveRuntimeCapabilitiesForTarget (a full replace), this
 * is safe when several independent grantors (e.g. a sandbox provision + a
 * manually-granted device capability) coexist on the same actor/conversation.
 * Idempotent per (capability, subject, scope) via the active partial-unique.
 */
export async function addRuntimeCapabilitiesForTarget(
  params: SetActiveRuntimeCapabilitiesParams,
  options?: { db?: Executor }
): Promise<void> {
  if (params.runtimeCapabilityIds.length === 0) return
  const { subjectId, scopeSubjectId } = await resolveScopedSubjectTarget(
    params.target,
    { db: options?.db }
  )
  await insertRuntimeCapabilityGrants(
    {
      workspaceId: params.workspaceId,
      subjectId,
      scopeSubjectId,
      capabilityIds: params.runtimeCapabilityIds,
      createdByWorkspaceMemberId: params.createdByWorkspaceMemberId,
      reason: params.reason,
    },
    options?.db
  )
}

/**
 * TARGETED capability revoke: revoke ONLY the given capability ids' active
 * bindings on (subject, scope), leaving the target's other capabilities intact.
 * The inverse of addRuntimeCapabilitiesForTarget — used at sandbox teardown so we
 * don't clobber an unrelated manual grant on the same actor/conversation.
 */
export async function revokeRuntimeCapabilitiesForTarget(
  params: SetActiveRuntimeCapabilitiesParams,
  options?: { db?: Executor }
): Promise<void> {
  if (params.runtimeCapabilityIds.length === 0) return
  const { subjectId, scopeSubjectId } = await resolveScopedSubjectTarget(
    params.target,
    { db: options?.db }
  )
  await revokeRuntimeCapabilityGrants(
    {
      workspaceId: params.workspaceId,
      subjectId,
      scopeSubjectId,
      capabilityIds: params.runtimeCapabilityIds,
      createdByWorkspaceMemberId: params.createdByWorkspaceMemberId,
      reason: params.reason,
    },
    options?.db
  )
}
