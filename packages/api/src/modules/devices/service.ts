// Devices module — service layer. Business logic + error-code mapping for
// list/get/delete + pairing session create/consume + daemon claim/detach. All
// direct DB access lives in repo.ts (guard r8); this file calls those repo fns
// and maps their domain results / discriminated outcomes to DeviceModuleError
// codes and the wire-facing result shapes.

import { randomUUID, randomBytes, createHash } from "node:crypto"
import {
  RUNTIME_PAIRING_MODES,
  RUNTIME_SERVICE_KINDS,
  DEVICE_TYPES,
  type RuntimePairingMode,
  type RuntimeServiceKind,
  type DeviceType,
} from "@synapse/device-protocol"
import type { OneClickInstallCommands } from "@synapse/shared"
import type {
  DeviceDetailRecord,
  RuntimePairingTicketRecord,
  RuntimeServiceRecord,
  DeviceSummaryRecord,
} from "./repo.types.js"
import {
  claimRemoteAgentDaemonTx,
  consumeLocalPairingTx,
  detachRuntimeServiceRpc,
  findDeviceDetail,
  insertLocalPairingSession,
  isRuntimeServiceOwnedByWorkspace,
  listDeviceSummaries,
  mintLocalSandboxRuntimeTx,
  mintBareSandboxRuntimeTx,
  softDeleteRuntime,
} from "./repo.js"
import type { RuntimeCatalogExposure } from "@synapse/device-protocol"
import type { Executor } from "../../infrastructure/database/kysely.js"
import { config } from "../../config/index.js"
import {
  buildDeviceInstallCommands,
  getRenderedInstallerArtifacts,
} from "../installer/install-command.js"

// One-click bootstrap installer commands for a local device pairing (carries
// the pairing code). null when no private registry is configured.
function buildDeviceOneClick(
  pairingCode: string
): OneClickInstallCommands | null {
  const artifacts = getRenderedInstallerArtifacts({
    serverUrl: config.app.baseUrl,
    privateRegistry: config.remoteAgent.npmRegistryUrl,
  })
  if (!artifacts) return null
  return buildDeviceInstallCommands({
    serverUrl: config.app.baseUrl,
    pairingCode,
    shaSh: artifacts.shaSh,
    shaPs1: artifacts.shaPs1,
  })
}

export class DeviceModuleError extends Error {
  readonly statusCode: number
  readonly code: string
  constructor(opts: { statusCode: number; code: string; message: string }) {
    super(opts.message)
    this.name = "DeviceModuleError"
    this.statusCode = opts.statusCode
    this.code = opts.code
  }
}

export async function listDevices(
  workspaceId: string
): Promise<DeviceSummaryRecord[]> {
  return listDeviceSummaries(workspaceId)
}

export async function getDevice(
  workspaceId: string,
  deviceId: string
): Promise<DeviceDetailRecord> {
  const detail = await findDeviceDetail(workspaceId, deviceId)
  if (!detail) {
    throw new DeviceModuleError({
      statusCode: 404,
      code: "device_not_found",
      message: `device ${deviceId} not found in workspace ${workspaceId}`,
    })
  }
  return detail
}

/**
 * Direct-mint a device-less LOCAL sandbox runtime (§4.6) — the service-layer
 * seam the local sandbox backend calls (it owns the on-disk broker identity;
 * this owns the atomic DB mint). Always adapter='local', mode='resident' in P2.
 */
export async function mintLocalSandboxRuntime(args: {
  runtimeId: string
  workspaceId: string
  sessionId: string
  serviceId: string
  serviceKeyId: string
  servicePubkey: string
  serviceFingerprint: string
  clientVersion?: string | null
  capabilityDescriptor?: Record<string, unknown>
}): Promise<{ runtimeId: string; serviceId: string; serviceKeyId: string }> {
  return mintLocalSandboxRuntimeTx({
    ...args,
    adapter: "local",
    mode: "resident",
  })
}

/**
 * Direct-mint a device-less BARE (Mode-B) sandbox runtime (§4.3) — the
 * service-layer seam the bare adapters call. No keypair/broker; the api-authored
 * catalog is persisted synchronously in the same tx. Returns the minted ids +
 * the assignedIds the dispatch fork's target-id check consumes.
 */
export async function mintBareSandboxRuntime(args: {
  runtimeId: string
  workspaceId: string
  sessionId: string
  serviceId: string
  adapter: string
  dataPlaneEndpoint: string
  capabilityDescriptor: Record<string, unknown>
  exposures: RuntimeCatalogExposure[]
  clientVersion?: string | null
}): ReturnType<typeof mintBareSandboxRuntimeTx> {
  return mintBareSandboxRuntimeTx(args)
}

export async function deleteDevice(
  workspaceId: string,
  deviceId: string
): Promise<void> {
  // Soft delete (design §5.3): runtimes are never hard-deleted in production —
  // softDeleteRuntime flips runtimes.deleted_at (the SOLE runtime soft-delete
  // root; the devices table has no deleted_at of its own) and KEEPS the runtime
  // detail + its runtime_* child rows (services/capabilities/operations) for
  // audit. Those rows are hidden from projection via the runtimes-liveness folds
  // and the *_live views (§8.6). Hard delete is forbidden by sd_reject_delete;
  // physical removal happens only via offline purge.
  //
  // requireKind:'device' — this is the workspace.manage_devices /devices/:id API,
  // which MUST NOT be able to terminate a sandbox runtime. A sandbox id fails the
  // kind guard (0 rows → 404), so device-management permission can't kill an Actor
  // sandbox. Sandbox teardown goes through deleteRuntime (below), never this.
  const updated = await softDeleteRuntime(workspaceId, deviceId, {
    requireKind: "device",
  })
  if (updated === 0) {
    throw new DeviceModuleError({
      statusCode: 404,
      code: "device_not_found",
      message: `device ${deviceId} not found in workspace ${workspaceId}`,
    })
  }
}

/**
 * Soft-delete a runtime of ANY kind (device or sandbox) by id. Internal sandbox
 * teardown path only (adapters + provision cleanup) — NOT reachable from the
 * device-management API, which uses the kind-scoped deleteDevice above. Throws
 * device_not_found if the runtime is already gone (callers treat teardown as
 * best-effort and swallow it).
 */
export async function deleteRuntime(
  workspaceId: string,
  runtimeId: string,
  run?: Executor
): Promise<void> {
  // `run` (optional) threads the sandbox teardown/crash-recovery executor into
  // the soft-delete flip; undefined preserves prod (global db) behaviour.
  const updated = await softDeleteRuntime(workspaceId, runtimeId, undefined, run)
  if (updated === 0) {
    throw new DeviceModuleError({
      statusCode: 404,
      // kind-neutral: deleteRuntime tears down a runtime of ANY kind (incl. a
      // device-less sandbox), so a device-specific code would misdescribe it.
      // The kind-scoped device paths (getDevice/deleteDevice) keep device_not_found.
      code: "runtime_not_found",
      message: `runtime ${runtimeId} not found in workspace ${workspaceId}`,
    })
  }
}

// ───────────────────────────── pairing ──────────────────────────────────────

const PAIRING_CODE_BYTES = 8 // 16 hex chars
const PAIRING_TTL_MINUTES = 10

function generatePairingCode(): string {
  return randomBytes(PAIRING_CODE_BYTES).toString("hex")
}

function generateBootstrapToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString("hex")
  const hash = createHash("sha256").update(token).digest()
  return { token, hash }
}

export type StartPairingResult = RuntimePairingTicketRecord

export interface StartPairingInput {
  workspaceId: string
  requestedByWorkspaceMemberId?: string | null
  mode: RuntimePairingMode
  serverBaseUrl: string
  title?: string
  description?: string
  deviceType?: DeviceType
  /** Which runtime kind this pairing mints (drives the P2 consume fork). Defaults
   *  to 'device' so real-device pairing stays byte-identical. */
  targetRuntimeKind?: "device" | "sandbox"
  /** mode-specific opaque context (cloud preset, service kind being joined, …) */
  context?: Record<string, unknown>
}

export async function startPairing(
  input: StartPairingInput
): Promise<StartPairingResult> {
  if (!RUNTIME_PAIRING_MODES.includes(input.mode)) {
    throw new DeviceModuleError({
      statusCode: 400,
      code: "invalid_pairing_mode",
      message: `unsupported pairing mode ${input.mode}`,
    })
  }
  if (input.deviceType && !DEVICE_TYPES.includes(input.deviceType)) {
    throw new DeviceModuleError({
      statusCode: 400,
      code: "invalid_device_type",
      message: `unsupported device type ${input.deviceType}`,
    })
  }

  const expiresAt = new Date(Date.now() + PAIRING_TTL_MINUTES * 60 * 1000)

  let pairingCode: string | null = null
  let bootstrapToken: string | null = null
  let bootstrapTokenHash: Buffer | null = null
  if (input.mode === "cloud_bootstrap") {
    const generated = generateBootstrapToken()
    bootstrapToken = generated.token
    bootstrapTokenHash = generated.hash
  } else {
    pairingCode = generatePairingCode()
  }

  const sessionId = randomUUID()
  await insertLocalPairingSession({
    sessionId,
    workspaceId: input.workspaceId,
    requestedByWorkspaceMemberId: input.requestedByWorkspaceMemberId ?? null,
    targetRuntimeKind: input.targetRuntimeKind ?? "device",
    mode: input.mode,
    serverBaseUrl: input.serverBaseUrl,
    requestedTitle: input.title ?? null,
    requestedDescription: input.description ?? null,
    requestedDeviceType: input.deviceType ?? null,
    pairingCode,
    bootstrapTokenHash,
    expiresAt,
    contextJson: JSON.stringify(input.context ?? {}),
  })

  return {
    pairingSessionId: sessionId,
    mode: input.mode,
    pairingCode: pairingCode,
    bootstrapToken: bootstrapToken,
    expiresAt: expiresAt,
    verificationUri: null,
    verificationUriComplete: null,
    status: "pending",
    // One-click bootstrap only applies to the local_qr code flow (pairingCode
    // present). cloud_bootstrap doesn't use the device installer.
    oneClickCommands:
      pairingCode !== null ? buildDeviceOneClick(pairingCode) : null,
  }
}

export interface ConsumePairingInput {
  pairingCode: string
  devicePubkey: string
  servicePubkey: string
  serviceKind: RuntimeServiceKind
  clientVersion?: string
  /** required at consume time for new local devices; ignored for cloud_bootstrap */
  title?: string
  deviceType?: DeviceType
  platform?: string
  /** process.arch as reported by the device runtime; together with
   *  platform forms the bundles manifest `platformKey` so the API can
   *  exact-match the toolchain availability table. */
  arch?: string
}

export interface ConsumePairingResult {
  device_id: string
  service_id: string
  service_key_id: string
  control_plane_url: string
}

/**
 * Local-pairing claim handler. The runtime exchanges its short pairing_code
 * for long-term credentials. The atomic consume (claim UPDATE + diagnostic
 * SELECT + devices/runtime_services/runtime_service_keys INSERTs + FK backfill)
 * is owned by repo.consumeLocalPairingTx as ONE transaction; this fn does the
 * pre-flight validation, fingerprint hashing, and maps the discriminated
 * failure outcomes to DeviceModuleError codes.
 *
 * Cloud bootstrap consumption is a separate endpoint (PR #12) because it
 * authenticates with the bootstrap_token instead of a pairing_code.
 */
export async function consumePairing(
  input: ConsumePairingInput,
  opts: { controlPlaneUrl: string }
): Promise<ConsumePairingResult> {
  if (!RUNTIME_SERVICE_KINDS.includes(input.serviceKind)) {
    throw new DeviceModuleError({
      statusCode: 400,
      code: "invalid_service_kind",
      message: `unsupported service kind ${input.serviceKind}`,
    })
  }
  if (input.serviceKind === "remote_agent_daemon") {
    // Daemon is v1-association-only (§5.2); use /devices/:id/services with
    // remote_agent_machine_id instead.
    throw new DeviceModuleError({
      statusCode: 400,
      code: "service_kind_not_pairable",
      message:
        "remote_agent_daemon is not paired via /pairing-sessions in v1; use the daemon claim endpoint (§5.4)",
    })
  }
  if (input.serviceKind !== "device_runtime") {
    // Only device_runtime is minted through local pairing; consumeLocalPairingTx
    // always writes 'device_runtime', so any other kind (e.g. bare_dataplane —
    // bare sandboxes direct-mint) would be a silent lie. Reject explicitly.
    throw new DeviceModuleError({
      statusCode: 400,
      code: "service_kind_not_pairable",
      message: `${input.serviceKind} is not paired via /pairing-sessions; local sandboxes direct-mint`,
    })
  }

  const pubkeyFingerprint = createHash("sha256")
    .update(input.devicePubkey)
    .digest("hex")
  const serviceFingerprint = createHash("sha256")
    .update(input.servicePubkey)
    .digest("hex")

  const result = await consumeLocalPairingTx({
    pairingCode: input.pairingCode,
    pubkeyFingerprint,
    serviceFingerprint,
    devicePubkey: input.devicePubkey,
    servicePubkey: input.servicePubkey,
    clientVersion: input.clientVersion ?? null,
    title: input.title,
    deviceType: input.deviceType,
    platform: input.platform,
    arch: input.arch,
  })

  if (result.outcome !== "ok") {
    switch (result.outcome) {
      case "not_found":
        throw new DeviceModuleError({
          statusCode: 404,
          code: "pairing_code_not_found",
          message: "pairing code not found or already consumed",
        })
      case "not_pending":
        throw new DeviceModuleError({
          statusCode: 409,
          code: "pairing_session_not_pending",
          message: `pairing session is ${result.existingStatus ?? "unknown"}`,
        })
      case "expired":
        throw new DeviceModuleError({
          statusCode: 410,
          code: "pairing_session_expired",
          message: "pairing session expired",
        })
      case "mode_mismatch":
        throw new DeviceModuleError({
          statusCode: 400,
          code: "pairing_mode_mismatch",
          message: `consumePairing only handles local_qr; got ${result.existingMode ?? "unknown"}`,
        })
      case "race":
        // Should not happen — race with another worker that claimed it between
        // our UPDATE and our diagnostic SELECT.
        throw new DeviceModuleError({
          statusCode: 409,
          code: "pairing_session_race",
          message:
            "pairing session was claimed by another consumer; retry not allowed",
        })
    }
  }

  return {
    device_id: result.deviceId,
    service_id: result.serviceId,
    service_key_id: result.serviceKeyId,
    control_plane_url: opts.controlPlaneUrl,
  }
}

// ───────────────────────────── daemon claim (§5.4) ──────────────────────────

export interface ClaimDaemonInput {
  workspaceId: string
  deviceId: string
  remoteAgentMachineId: string
}

export async function claimRemoteAgentDaemon(
  input: ClaimDaemonInput
): Promise<RuntimeServiceRecord> {
  const result = await claimRemoteAgentDaemonTx(input)
  if (result.outcome !== "ok") {
    switch (result.outcome) {
      case "device_not_found":
        throw new DeviceModuleError({
          statusCode: 404,
          code: "device_not_found",
          message: `device ${input.deviceId} not found in workspace ${input.workspaceId}`,
        })
      case "machine_not_found":
        throw new DeviceModuleError({
          statusCode: 404,
          code: "remote_agent_machine_not_found",
          message: `remote agent machine ${input.remoteAgentMachineId} not found`,
        })
      case "workspace_mismatch":
        throw new DeviceModuleError({
          statusCode: 400,
          code: "remote_agent_machine_workspace_mismatch",
          message:
            "remote agent machine must belong to the same workspace as the device",
        })
      case "already_claimed":
        throw new DeviceModuleError({
          statusCode: 409,
          code: "remote_agent_machine_already_claimed",
          message: `remote_agent_machine ${input.remoteAgentMachineId} is already attached to a device`,
        })
    }
  }
  return result.service
}

export async function detachRuntimeService(
  workspaceId: string,
  deviceId: string,
  serviceId: string
): Promise<void> {
  // Verify the service belongs to a device in this workspace before detaching.
  const owned = await isRuntimeServiceOwnedByWorkspace(
    workspaceId,
    deviceId,
    serviceId
  )
  if (!owned) {
    throw new DeviceModuleError({
      statusCode: 404,
      code: "runtime_service_not_found",
      message: `device_service ${serviceId} not found on device ${deviceId}`,
    })
  }
  // runtime_services is a persistent child guarded by sd_reject_delete; the
  // physical detach goes through the SECURITY DEFINER fn (design §7.5/§11).
  await detachRuntimeServiceRpc(serviceId, deviceId)
}
