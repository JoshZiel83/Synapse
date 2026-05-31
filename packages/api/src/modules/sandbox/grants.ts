// Two-layer authorization for a provisioned sandbox.
//
// A sandbox can only run its fs + commandline tools once BOTH layers exist —
// either alone results in a local deny:
//   Layer 1 — capability device grant (resource_access_bindings): binds the
//     actor (scope=conversation) to the device's filesystem + commandline
//     capabilities, so projectDeviceTools surfaces the tools at all.
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
import { db } from "../../infrastructure/database/kysely.js"
import type { KyselyDb } from "../../infrastructure/database/kysely.js"
import { setActiveDeviceCapabilitiesForTarget } from "../capability-projection/device-capabilities.js"
import { createRuntimeAuthorizationGrant } from "../runtime-authorizations/service.js"

export class SandboxGrantsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SandboxGrantsError"
  }
}

export interface DeviceBuiltinIds {
  /** device_exposures.id for builtin_kind='filesystem'. */
  filesystemExposureId: string
  /** device_capabilities.id for the filesystem exposure. */
  filesystemCapabilityId: string
  /** device_exposures.id for builtin_kind='commandline' (null if absent). */
  commandlineExposureId: string | null
  /** device_capabilities.id for the commandline exposure (null if absent). */
  commandlineCapabilityId: string | null
}

/**
 * Resolve the filesystem + commandline exposure/capability ids for a device
 * after its catalog has synced. Returns null for commandline ids when the
 * device didn't advertise a commandline builtin (mac/win/no-bwrap fallback).
 * Throws if the filesystem exposure/capability is missing (a sandbox always
 * exposes filesystem).
 */
export async function resolveDeviceBuiltinIds(
  deviceId: string,
  dbh: KyselyDb = db
): Promise<DeviceBuiltinIds> {
  const rows = await dbh
    .selectFrom("device_exposures as e")
    .innerJoin("device_capabilities as c", "c.exposure_id", "e.id")
    .select(["e.id as exposure_id", "c.id as capability_id", "e.builtin_kind"])
    .where("e.device_id", "=", deviceId)
    .where("c.status", "=", "active")
    .where("e.builtin_kind", "in", ["filesystem", "commandline"])
    .execute()

  let fsExposure: string | null = null
  let fsCapability: string | null = null
  let cmdExposure: string | null = null
  let cmdCapability: string | null = null
  for (const row of rows) {
    if (row.builtin_kind === "filesystem") {
      fsExposure = row.exposure_id as string
      fsCapability = row.capability_id as string
    } else if (row.builtin_kind === "commandline") {
      cmdExposure = row.exposure_id as string
      cmdCapability = row.capability_id as string
    }
  }
  if (!fsExposure || !fsCapability) {
    throw new SandboxGrantsError(
      `device ${deviceId} has no active filesystem capability (catalog not synced?)`
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
  deviceId: string
  actorId: string
  conversationId: string
  builtins: DeviceBuiltinIds
  /**
   * Whether to build the commandline sandbox grant. false = fail-closed
   * (no bwrap/userns): only fs tools are authorized.
   */
  includeCommandline: boolean
  createdByWorkspaceMemberId?: string | null
}

/**
 * Create BOTH authorization layers for a sandbox, scoped to (actor, conversation).
 * Idempotent at Layer 1 (setActiveDeviceCapabilitiesForTarget revokes-then-inserts
 * the full list in one pass). Layer 2 grants are created with retention
 * 'until_revoked' so they live for the session and are torn down explicitly.
 */
export async function createSandboxGrants(
  params: CreateSandboxGrantsParams
): Promise<void> {
  const { workspaceId, deviceId, actorId, conversationId, builtins } = params

  // ── Layer 1: capability device grant (whole list in one pass) ──
  const capabilityIds = [builtins.filesystemCapabilityId]
  if (params.includeCommandline && builtins.commandlineCapabilityId) {
    capabilityIds.push(builtins.commandlineCapabilityId)
  }
  await setActiveDeviceCapabilitiesForTarget({
    workspaceId,
    target: {
      kind: "actor_in_conversation",
      actorId,
      conversationId,
    },
    deviceCapabilityIds: capabilityIds,
    createdByWorkspaceMemberId: params.createdByWorkspaceMemberId ?? null,
    reason: "sandbox provision",
  })

  // ── Layer 2: runtime-authorization grants ──
  const subject = actorRef(actorId)
  const scope = conversationRef(conversationId)

  // (a) filesystem write over the three mount points.
  const fsPolicy: SharedRuntimeAuthorizationGrantSpec = {
    capability: "filesystem",
    filesystem: {
      access: "write",
      pathPrefixes: [...SANDBOX_MOUNT_POINTS],
    },
  }
  await createRuntimeAuthorizationGrant({
    workspaceId,
    deviceId,
    deviceCapabilityId: builtins.filesystemCapabilityId,
    deviceExposureId: builtins.filesystemExposureId,
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
      deviceId,
      deviceCapabilityId: builtins.commandlineCapabilityId,
      deviceExposureId: builtins.commandlineExposureId,
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
 * Revoke both layers for a torn-down sandbox: clear the actor's device
 * capability bindings (empty list = revoke all) and revoke the runtime grants
 * for this (device, actor, conversation). Runtime grants are revoked by the
 * generic revoke path keyed on the device.
 */
export async function revokeSandboxGrants(params: {
  workspaceId: string
  deviceId: string
  actorId: string
  conversationId: string
}): Promise<void> {
  // Layer 1: empty capability list = revoke all bindings for this target.
  await setActiveDeviceCapabilitiesForTarget({
    workspaceId: params.workspaceId,
    target: {
      kind: "actor_in_conversation",
      actorId: params.actorId,
      conversationId: params.conversationId,
    },
    deviceCapabilityIds: [],
    reason: "sandbox teardown",
  })

  // Layer 2: revoke all active runtime grants for this device. The device is
  // about to be deleted and its grant FK is ON DELETE CASCADE, so deletion
  // alone would remove them — but we revoke first for a clean audit trail and
  // so a teardown that stops short of deleteDevice still leaves no live grants.
  await db
    .updateTable("runtime_authorization_grants")
    .set({
      status: "revoked",
      revoked_at: new Date().toISOString(),
    } as never)
    .where("device_id", "=", params.deviceId)
    .where("workspace_id", "=", params.workspaceId)
    .where("status", "=", "active")
    .execute()
}
