// Two-layer authorization for a provisioned sandbox.
//
// A sandbox can only run its fs + commandline tools once BOTH layers exist —
// either alone results in a local deny:
//   Layer 1 — capability device grant (workspace_resource_grants): binds the
//     actor (scope=conversation) to the device's filesystem + commandline
//     capabilities, so projectRuntimeTools surfaces the tools at all.
//   Layer 2 — runtime-authorization grants: a filesystem write grant over the
//     three mount points + a commandline grant with the executor:"sandbox"
//     variant (bwrap-confined any-command). Pre-authorized once at provision so
//     the agent isn't prompted per command.
//
// fail-closed: when the host lacks bwrap/userns, the caller passes
// includeCommandline=false so we never build the sandbox commandline grant or
// surface the commandline capability — the fs tools still work (VFS root jail).

import {
  actorRef,
  conversationRef,
  type SharedRuntimeAuthorizationGrantSpec,
  SANDBOX_MOUNT_POINTS,
} from "@synapse/shared"
import type { Executor } from "./repo.js"
import {
  selectRuntimeBuiltinExposures,
  selectRuntimeCapabilityIds,
  revokeActiveRuntimeGrants,
} from "./repo.js"
import {
  addRuntimeCapabilitiesForTarget,
  revokeRuntimeCapabilitiesForTarget,
} from "../capability-projection/device-capabilities.js"
import { createRuntimeAuthorizationGrant } from "../runtime-authorizations/service.js"

export class SandboxGrantsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SandboxGrantsError"
  }
}

export interface RuntimeBuiltinIds {
  /** runtime_exposures.id for builtin_kind='filesystem'. */
  filesystemExposureId: string
  /** runtime_capabilities.id for the filesystem exposure. */
  filesystemCapabilityId: string
  /** runtime_exposures.id for builtin_kind='commandline' (null if absent). */
  commandlineExposureId: string | null
  /** runtime_capabilities.id for the commandline exposure (null if absent). */
  commandlineCapabilityId: string | null
}

/**
 * Resolve the filesystem + commandline exposure/capability ids for a device
 * after its catalog has synced. Returns null for commandline ids when the
 * device didn't advertise a commandline builtin (mac/win/no-bwrap fallback).
 * Throws if the filesystem exposure/capability is missing (a sandbox always
 * exposes filesystem).
 */
export async function resolveRuntimeBuiltinIds(
  runtimeId: string,
  run?: Executor
): Promise<RuntimeBuiltinIds> {
  const rows = await selectRuntimeBuiltinExposures(runtimeId, run)

  let fsExposure: string | null = null
  let fsCapability: string | null = null
  let cmdExposure: string | null = null
  let cmdCapability: string | null = null
  for (const row of rows) {
    if (row.builtinKind === "filesystem") {
      fsExposure = row.exposureId as string
      fsCapability = row.capabilityId as string
    } else if (row.builtinKind === "commandline") {
      cmdExposure = row.exposureId as string
      cmdCapability = row.capabilityId as string
    }
  }
  if (!fsExposure || !fsCapability) {
    throw new SandboxGrantsError(
      `runtime ${runtimeId} has no active filesystem capability (catalog not synced?)`
    )
  }
  return {
    filesystemExposureId: fsExposure,
    filesystemCapabilityId: fsCapability,
    commandlineExposureId: cmdExposure,
    commandlineCapabilityId: cmdCapability,
  }
}

export interface CreateSandboxGrantsParams {
  workspaceId: string
  runtimeId: string
  actorId: string
  conversationId: string
  builtins: RuntimeBuiltinIds
  /**
   * Whether to build the commandline sandbox grant. false = fail-closed
   * (no bwrap/userns): only fs tools are authorized.
   */
  includeCommandline: boolean
  /**
   * The adapter descriptor's fs-confinement posture (P4a S13). 'native' (default)
   * mints the SUB-PREFIX fs grant over the three mount points — the plane can
   * realpath-confine to those. 'unsupported' (a genuinely remote fs that can't
   * sub-confine, e.g. a degraded provider) REFUSES the sub-prefix grant and mints
   * a WHOLE-SANDBOX-scope grant instead (pathPrefixes:["/"]) → deriveConfinementScope
   * yields WHOLE_SCOPE (root-jail), NEVER []/deny (F-C). expected_sha256/create_only
   * are then advisory (the descriptor's staleWriteGuard is 'advisory').
   */
  confinedFs?: "native" | "unsupported"
  createdByWorkspaceMemberId?: string | null
}

/**
 * Create BOTH authorization layers for a sandbox, scoped to (actor, conversation).
 * Idempotent at Layer 1 (setActiveRuntimeCapabilitiesForTarget revokes-then-inserts
 * the full list in one pass). Layer 2 grants are created with retention
 * 'until_revoked' so they live for the session and are torn down explicitly.
 */
export async function createSandboxGrants(
  params: CreateSandboxGrantsParams
): Promise<void> {
  const { workspaceId, runtimeId, actorId, conversationId, builtins } = params

  // ── Layer 1: capability device grant (ADDITIVE — only the sandbox's own
  // capabilities, never clobbering a pre-existing manual grant on this actor
  // /conversation) ──
  const capabilityIds = [builtins.filesystemCapabilityId]
  if (params.includeCommandline && builtins.commandlineCapabilityId) {
    capabilityIds.push(builtins.commandlineCapabilityId)
  }
  await addRuntimeCapabilitiesForTarget({
    workspaceId,
    target: {
      kind: "actor",
      actorId,
      conversationId,
    },
    runtimeCapabilityIds: capabilityIds,
    createdByWorkspaceMemberId: params.createdByWorkspaceMemberId ?? null,
    reason: "sandbox provision",
  })

  // ── Layer 2: runtime-authorization grants ──
  const subject = actorRef(actorId)
  const scope = conversationRef(conversationId)

  // (a) filesystem write. 'native' confinement → the three mount points (the
  // plane realpath-confines to them). 'unsupported' (degraded, S13) → REFUSE the
  // sub-prefix grant; mint a WHOLE-SANDBOX-scope grant (the whole VFS root) so the
  // plane runs root-jailed (WHOLE_SCOPE), never with an unenforceable sub-prefix.
  const fsPolicy: SharedRuntimeAuthorizationGrantSpec = {
    capability: "filesystem",
    filesystem: {
      access: "write",
      pathPrefixes:
        params.confinedFs === "unsupported" ? ["/"] : [...SANDBOX_MOUNT_POINTS],
    },
  }
  await createRuntimeAuthorizationGrant({
    workspaceId,
    runtimeId,
    runtimeCapabilityId: builtins.filesystemCapabilityId,
    runtimeExposureId: builtins.filesystemExposureId,
    subject,
    scope,
    retention: "until_revoked",
    policy: fsPolicy,
    createdByWorkspaceMemberId: params.createdByWorkspaceMemberId ?? undefined,
  })

  // (b) commandline sandbox grant — only when bwrap confinement is available.
  if (
    params.includeCommandline &&
    builtins.commandlineCapabilityId &&
    builtins.commandlineExposureId
  ) {
    const cmdPolicy: SharedRuntimeAuthorizationGrantSpec = {
      capability: "commandline",
      commandline: {
        executor: "sandbox",
        // No workingDirectory cap → the whole sandbox (all mount points).
      },
    }
    await createRuntimeAuthorizationGrant({
      workspaceId,
      runtimeId,
      runtimeCapabilityId: builtins.commandlineCapabilityId,
      runtimeExposureId: builtins.commandlineExposureId,
      subject,
      scope,
      retention: "until_revoked",
      policy: cmdPolicy,
      createdByWorkspaceMemberId:
        params.createdByWorkspaceMemberId ?? undefined,
    })
  }
}

/**
 * Revoke both layers for a torn-down sandbox. Layer 1 is a TARGETED revoke of
 * only THIS device's capability bindings on (actor, conversation) — never the
 * full-replace empty-list path, which would also revoke any unrelated manual
 * capability grant on the same actor/conversation. Layer 2 revokes this device's
 * active runtime grants.
 */
export async function revokeSandboxGrants(params: {
  workspaceId: string
  runtimeId: string
  actorId: string
  conversationId: string
}): Promise<void> {
  // Layer 1: resolve THIS runtime's capability ids, then targeted-revoke only
  // those bindings (leaving other capabilities the actor/conversation may hold).
  const runtimeCapabilityIds = await selectRuntimeCapabilityIds({
    workspaceId: params.workspaceId,
    runtimeId: params.runtimeId,
  })
  if (runtimeCapabilityIds.length > 0) {
    await revokeRuntimeCapabilitiesForTarget({
      workspaceId: params.workspaceId,
      target: {
        kind: "actor",
        actorId: params.actorId,
        conversationId: params.conversationId,
      },
      runtimeCapabilityIds,
      reason: "sandbox teardown",
    })
  }

  // Layer 2: revoke all active runtime grants for this runtime. The runtime is
  // about to be soft-deleted and its grant FK is ON DELETE CASCADE, so deletion
  // alone would remove them — but we revoke first for a clean audit trail and
  // so a teardown that stops short of deletion still leaves no live grants.
  await revokeActiveRuntimeGrants({
    workspaceId: params.workspaceId,
    runtimeId: params.runtimeId,
  })
}
