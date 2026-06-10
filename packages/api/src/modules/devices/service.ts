// Devices module — service layer. SQL queries against the device_* tables
// added in PR #1. v3.0 skeleton: covers list/get/delete + pairing session
// create/consume. Full lifecycle (claim daemon, cloud bootstrap, re-key)
// lands across later PRs.

import { randomUUID, randomBytes, createHash } from "node:crypto"
import { sql } from "kysely"
import {
  DEVICE_PAIRING_MODES,
  DEVICE_PAIRING_STATUSES,
  DEVICE_SERVICE_KINDS,
  DEVICE_TYPES,
  type DeviceCapabilitySummary,
  type DeviceDetail,
  type DevicePairingMode,
  type DeviceServiceKind,
  type DeviceServiceSummary,
  type DeviceSummary,
  type DeviceType,
  type HostKind,
} from "@synapse/device-protocol"
import {
  dateToIsoInstant,
  type IsoInstantString,
} from "@synapse/shared/datetime"
import type { OneClickInstallCommands } from "@synapse/shared"
import { db } from "../../infrastructure/database/kysely.js"
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

function toIsoInstant(value: Date | null | undefined): IsoInstantString | null {
  if (!value) return null
  return dateToIsoInstant(value)
}

function serializeDeviceSummary(row: {
  id: string
  workspaceId: string
  title: string
  hostKind: HostKind
  hostProvider: string | null
  deviceType: DeviceType
  platform: string | null
  trustStatus: "pending" | "trusted" | "revoked"
  lastSeenAt: Date | null
  lastConnectedAt: Date | null
}): DeviceSummary {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    title: row.title,
    host_kind: row.hostKind,
    host_provider: row.hostProvider,
    device_type: row.deviceType,
    platform: row.platform,
    trust_status: row.trustStatus,
    last_seen_at: toIsoInstant(row.lastSeenAt),
    last_connected_at: toIsoInstant(row.lastConnectedAt),
  }
}

export async function listDevices(
  workspaceId: string
): Promise<DeviceSummary[]> {
  const rows = await db
    .selectFrom("devices")
    .selectAll()
    .where("workspaceId", "=", workspaceId)
    .where("deletedAt", "is", null)
    .orderBy("createdAt", "desc")
    .execute()
  return rows.map((row) =>
    serializeDeviceSummary({
      id: row.id as string,
      workspaceId: row.workspaceId as string,
      title: row.title as string,
      hostKind: row.hostKind as HostKind,
      hostProvider: row.hostProvider as string | null,
      deviceType: row.deviceType as DeviceType,
      platform: row.platform as string | null,
      trustStatus: row.trustStatus as "pending" | "trusted" | "revoked",
      lastSeenAt: row.lastSeenAt as Date | null,
      lastConnectedAt: row.lastConnectedAt as Date | null,
    })
  )
}

export async function getDevice(
  workspaceId: string,
  deviceId: string
): Promise<DeviceDetail> {
  const deviceRow = await db
    .selectFrom("devices")
    .selectAll()
    .where("workspaceId", "=", workspaceId)
    .where("id", "=", deviceId)
    .where("deletedAt", "is", null)
    .executeTakeFirst()
  if (!deviceRow) {
    throw new DeviceModuleError({
      statusCode: 404,
      code: "device_not_found",
      message: `device ${deviceId} not found in workspace ${workspaceId}`,
    })
  }

  const serviceRows = await db
    .selectFrom("deviceServices")
    .selectAll()
    .where("deviceId", "=", deviceId)
    .orderBy("createdAt", "asc")
    .execute()
  const services: DeviceServiceSummary[] = serviceRows.map((row) => ({
    id: row.id as string,
    device_id: row.deviceId as string,
    service_kind: row.serviceKind as DeviceServiceKind,
    version: (row.version as string | null) ?? null,
    status: row.status as "starting" | "online" | "degraded" | "offline",
    last_seen_at: toIsoInstant(row.lastSeenAt as Date | null),
    remote_agent_machine_id:
      (row.remoteAgentMachineId as string | null) ?? null,
  }))

  const capabilityRows = await db
    .selectFrom("deviceCapabilities as dc")
    .innerJoin("workspaceApps as app", "app.id", "dc.id")
    .innerJoin("deviceExposures as dx", "dx.id", "dc.exposureId")
    .select([
      "dc.id as id",
      "app.workspaceId as workspaceId",
      "dc.exposureId as exposureId",
      "dx.stableKey as exposureStableKey",
      "app.displayName as displayName",
      "dx.transport as transport",
      "dx.builtinKind as builtinKind",
      "dx.runtimeStatus as runtimeStatus",
      "dx.metadata as exposureMetadata",
    ])
    .where("dx.deviceId", "=", deviceId)
    .where("app.deletedAt", "is", null)
    .where("app.status", "=", "active")
    .execute()
  const capabilities: DeviceCapabilitySummary[] = capabilityRows.map((row) => ({
    id: row.id as string,
    workspace_id: row.workspaceId as string,
    exposure_id: row.exposureId as string,
    exposure_stable_key: row.exposureStableKey as string,
    display_name: row.displayName as string,
    transport: row.transport as DeviceCapabilitySummary["transport"],
    builtin_kind:
      (row.builtinKind as DeviceCapabilitySummary["builtin_kind"]) ?? null,
    runtime_status:
      row.runtimeStatus as DeviceCapabilitySummary["runtime_status"],
    metadata: (row.exposureMetadata as Record<string, unknown> | null) ?? null,
  }))

  return {
    ...serializeDeviceSummary({
      id: deviceRow.id as string,
      workspaceId: deviceRow.workspaceId as string,
      title: deviceRow.title as string,
      hostKind: deviceRow.hostKind as HostKind,
      hostProvider: deviceRow.hostProvider as string | null,
      deviceType: deviceRow.deviceType as DeviceType,
      platform: deviceRow.platform as string | null,
      trustStatus: deviceRow.trustStatus as "pending" | "trusted" | "revoked",
      lastSeenAt: deviceRow.lastSeenAt as Date | null,
      lastConnectedAt: deviceRow.lastConnectedAt as Date | null,
    }),
    description: (deviceRow.description as string | null) ?? null,
    owner_workspace_member_id:
      (deviceRow.ownerWorkspaceMemberId as string | null) ?? null,
    services,
    capabilities,
  }
}

export async function deleteDevice(
  workspaceId: string,
  deviceId: string
): Promise<void> {
  // Soft delete (design §5.3): devices are never hard-deleted in production —
  // both user-registered devices and per-session sandbox devices flip deleted_at
  // and KEEP their device_* child rows (services/capabilities/operations) for
  // audit. Child rows are hidden from projection via the device-liveness filter
  // and the *_live views (§8.6). Hard delete is forbidden by sd_reject_delete;
  // physical removal happens only via offline purge.
  const result = await db
    .updateTable("devices")
    .set({ deletedAt: new Date() })
    .where("workspaceId", "=", workspaceId)
    .where("id", "=", deviceId)
    .where("deletedAt", "is", null)
    .executeTakeFirst()
  if (Number(result.numUpdatedRows ?? 0) === 0) {
    throw new DeviceModuleError({
      statusCode: 404,
      code: "device_not_found",
      message: `device ${deviceId} not found in workspace ${workspaceId}`,
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

export interface StartPairingResult {
  pairing_session_id: string
  mode: DevicePairingMode
  pairing_code: string | null
  /**
   * For cloud_bootstrap mode only: the one-time token to inject into the
   * sandbox env. NOT persisted server-side (only its hash is). Caller MUST
   * relay it to the sandbox in the same request.
   */
  bootstrap_token: string | null
  expires_at: IsoInstantString
  verification_uri: string | null
  verification_uri_complete: string | null
  status: (typeof DEVICE_PAIRING_STATUSES)[number]
  /**
   * One-click bootstrap installer commands ({unix, windows}) embedding the
   * pairing code. Present for local_qr (code) pairings when a private registry
   * is configured; null otherwise.
   */
  one_click_commands: OneClickInstallCommands | null
}

export interface StartPairingInput {
  workspaceId: string
  requestedByWorkspaceMemberId?: string | null
  mode: DevicePairingMode
  serverBaseUrl: string
  title?: string
  description?: string
  deviceType?: DeviceType
  /** for service_join mode only */
  deviceId?: string
  /** mode-specific opaque context (cloud preset, service kind being joined, …) */
  context?: Record<string, unknown>
}

export async function startPairing(
  input: StartPairingInput
): Promise<StartPairingResult> {
  if (!DEVICE_PAIRING_MODES.includes(input.mode)) {
    throw new DeviceModuleError({
      statusCode: 400,
      code: "invalid_pairing_mode",
      message: `unsupported pairing mode ${input.mode}`,
    })
  }
  if (input.mode === "service_join" && !input.deviceId) {
    throw new DeviceModuleError({
      statusCode: 400,
      code: "service_join_requires_device_id",
      message: "service_join pairing requires deviceId",
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
  await db
    .insertInto("devicePairingSessions")
    .values({
      id: sessionId,
      workspaceId: input.workspaceId,
      requestedByWorkspaceMemberId: input.requestedByWorkspaceMemberId ?? null,
      deviceId: input.deviceId ?? null,
      mode: input.mode,
      serverBaseUrl: input.serverBaseUrl,
      requestedTitle: input.title ?? null,
      requestedDescription: input.description ?? null,
      requestedDeviceType: input.deviceType ?? null,
      pairingCode: pairingCode,
      bootstrapTokenHash: bootstrapTokenHash,
      verificationUri: null,
      verificationUriComplete: null,
      expiresAt: expiresAt,
      status: "pending",
      context: sql`${JSON.stringify(input.context ?? {})}::jsonb`,
    } as never)
    .execute()

  return {
    pairing_session_id: sessionId,
    mode: input.mode,
    pairing_code: pairingCode,
    bootstrap_token: bootstrapToken,
    expires_at: dateToIsoInstant(expiresAt),
    verification_uri: null,
    verification_uri_complete: null,
    status: "pending",
    // One-click bootstrap only applies to the local_qr code flow (pairingCode
    // present). cloud_bootstrap / service_join don't use the device installer.
    one_click_commands:
      pairingCode !== null ? buildDeviceOneClick(pairingCode) : null,
  }
}

export interface ConsumePairingInput {
  pairingCode: string
  devicePubkey: string
  servicePubkey: string
  serviceKind: DeviceServiceKind
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
 * for long-term credentials. Atomically INSERTs devices + device_services +
 * device_service_keys and marks the pairing session consumed.
 *
 * Cloud bootstrap consumption is a separate endpoint (PR #12) because it
 * authenticates with the bootstrap_token instead of a pairing_code.
 */
export async function consumePairing(
  input: ConsumePairingInput,
  opts: { controlPlaneUrl: string }
): Promise<ConsumePairingResult> {
  if (!DEVICE_SERVICE_KINDS.includes(input.serviceKind)) {
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

  const pubkeyFingerprint = createHash("sha256")
    .update(input.devicePubkey)
    .digest("hex")
  const serviceFingerprint = createHash("sha256")
    .update(input.servicePubkey)
    .digest("hex")

  return db.transaction().execute(async (trx) => {
    // Atomic single-shot consume: UPDATE the pairing session with status
    // change conditioned on it still being pending + matching mode + not
    // expired. RETURNING gives us the full row on success; nothing on any
    // race-loss or invalid state. Two concurrent claim attempts can no
    // longer both produce a trusted device.
    const claimedRows = await trx
      .updateTable("devicePairingSessions")
      .set({
        status: "consumed",
        confirmedAt: sql`NOW()`,
        consumedAt: sql`NOW()`,
      } as never)
      .where("pairingCode", "=", input.pairingCode)
      .where("status", "=", "pending")
      .where("mode", "=", "local_qr")
      .where("expiresAt", ">", sql<Date>`NOW()`)
      .returningAll()
      .execute()
    const session = claimedRows[0]
    if (!session) {
      // Distinguish the failure mode for a better error code so the
      // operator/runtime can react. We do a follow-up SELECT (still inside
      // the transaction) to figure out which precondition failed.
      const existing = await trx
        .selectFrom("devicePairingSessions")
        .selectAll()
        .where("pairingCode", "=", input.pairingCode)
        .executeTakeFirst()
      if (!existing) {
        throw new DeviceModuleError({
          statusCode: 404,
          code: "pairing_code_not_found",
          message: "pairing code not found or already consumed",
        })
      }
      if ((existing.status as string) !== "pending") {
        throw new DeviceModuleError({
          statusCode: 409,
          code: "pairing_session_not_pending",
          message: `pairing session is ${existing.status as string}`,
        })
      }
      const expiresAt = new Date(
        existing.expiresAt as unknown as string
      ).getTime()
      if (Number.isFinite(expiresAt) && expiresAt < Date.now()) {
        throw new DeviceModuleError({
          statusCode: 410,
          code: "pairing_session_expired",
          message: "pairing session expired",
        })
      }
      if ((existing.mode as string) !== "local_qr") {
        throw new DeviceModuleError({
          statusCode: 400,
          code: "pairing_mode_mismatch",
          message: `consumePairing only handles local_qr; got ${existing.mode as string}`,
        })
      }
      // Should not happen — race with another worker that claimed it between
      // our UPDATE and our diagnostic SELECT.
      throw new DeviceModuleError({
        statusCode: 409,
        code: "pairing_session_race",
        message:
          "pairing session was claimed by another consumer; retry not allowed",
      })
    }

    const deviceId = randomUUID()
    const serviceId = randomUUID()
    const serviceKeyId = randomUUID()
    const title = input.title ?? session.requestedTitle ?? "Device"
    const deviceType =
      input.deviceType ??
      (session.requestedDeviceType as DeviceType | null) ??
      ("desktop_computer" as DeviceType)

    await trx
      .insertInto("devices")
      .values({
        id: deviceId,
        workspaceId: session.workspaceId as string,
        ownerWorkspaceMemberId: session.requestedByWorkspaceMemberId ?? null,
        title,
        description: (session.requestedDescription as string | null) ?? null,
        hostKind: "local",
        hostProvider: null,
        deviceType: deviceType,
        platform: input.platform ?? null,
        arch: input.arch ?? null,
        publicKey: input.devicePubkey,
        publicKeyFingerprint: pubkeyFingerprint,
        trustStatus: "trusted",
      } as never)
      .execute()

    await trx
      .insertInto("deviceServices")
      .values({
        id: serviceId,
        deviceId: deviceId,
        serviceKind: "device_runtime",
        version: input.clientVersion ?? null,
        status: "starting",
        metadata: sql`'{}'::jsonb`,
      } as never)
      .execute()

    await trx
      .insertInto("deviceServiceKeys")
      .values({
        id: serviceKeyId,
        serviceId: serviceId,
        pubkey: input.servicePubkey,
        pubkeyFingerprint: serviceFingerprint,
      } as never)
      .execute()

    // Backfill device_id on the already-consumed pairing session row. The
    // earlier atomic UPDATE flipped status/timestamps; we just need the FK
    // wired now that the device row exists.
    await trx
      .updateTable("devicePairingSessions")
      .set({
        deviceId: deviceId,
      } as never)
      .where("id", "=", session.id as string)
      .execute()

    return {
      device_id: deviceId,
      service_id: serviceId,
      service_key_id: serviceKeyId,
      control_plane_url: opts.controlPlaneUrl,
    }
  })
}

// ───────────────────────────── daemon claim (§5.4) ──────────────────────────

export interface ClaimDaemonInput {
  workspaceId: string
  deviceId: string
  remoteAgentMachineId: string
}

export async function claimRemoteAgentDaemon(
  input: ClaimDaemonInput
): Promise<DeviceServiceSummary> {
  return db.transaction().execute(async (trx) => {
    const device = await trx
      .selectFrom("devices")
      .selectAll()
      .where("workspaceId", "=", input.workspaceId)
      .where("id", "=", input.deviceId)
      .executeTakeFirst()
    if (!device) {
      throw new DeviceModuleError({
        statusCode: 404,
        code: "device_not_found",
        message: `device ${input.deviceId} not found in workspace ${input.workspaceId}`,
      })
    }

    const machine = await trx
      .selectFrom("remoteAgentMachines")
      .select(["id", "workspaceId"])
      .where("id", "=", input.remoteAgentMachineId)
      .executeTakeFirst()
    if (!machine) {
      throw new DeviceModuleError({
        statusCode: 404,
        code: "remote_agent_machine_not_found",
        message: `remote agent machine ${input.remoteAgentMachineId} not found`,
      })
    }
    if (machine.workspaceId !== input.workspaceId) {
      throw new DeviceModuleError({
        statusCode: 400,
        code: "remote_agent_machine_workspace_mismatch",
        message:
          "remote agent machine must belong to the same workspace as the device",
      })
    }

    const existing = await trx
      .selectFrom("deviceServices")
      .selectAll()
      .where("remoteAgentMachineId", "=", input.remoteAgentMachineId)
      .where("serviceKind", "=", "remote_agent_daemon")
      .executeTakeFirst()
    if (existing) {
      throw new DeviceModuleError({
        statusCode: 409,
        code: "remote_agent_machine_already_claimed",
        message: `remote_agent_machine ${input.remoteAgentMachineId} is already attached to a device`,
      })
    }

    const serviceId = randomUUID()
    await trx
      .insertInto("deviceServices")
      .values({
        id: serviceId,
        deviceId: input.deviceId,
        serviceKind: "remote_agent_daemon",
        version: null,
        status: "online",
        metadata: sql`'{}'::jsonb`,
        remoteAgentMachineId: input.remoteAgentMachineId,
      } as never)
      .execute()

    const row = await trx
      .selectFrom("deviceServices")
      .selectAll()
      .where("id", "=", serviceId)
      .executeTakeFirstOrThrow()

    return {
      id: row.id as string,
      device_id: row.deviceId as string,
      service_kind: row.serviceKind as DeviceServiceKind,
      version: (row.version as string | null) ?? null,
      status: row.status as "starting" | "online" | "degraded" | "offline",
      last_seen_at: toIsoInstant(row.lastSeenAt as Date | null),
      remote_agent_machine_id:
        (row.remoteAgentMachineId as string | null) ?? null,
    }
  })
}

export async function detachDeviceService(
  workspaceId: string,
  deviceId: string,
  serviceId: string
): Promise<void> {
  // Verify the service belongs to a device in this workspace before detaching.
  const owned = await db
    .selectFrom("deviceServices as ds")
    .innerJoin("devices as d", "d.id", "ds.deviceId")
    .select("ds.id")
    .where("ds.id", "=", serviceId)
    .where("ds.deviceId", "=", deviceId)
    .where("d.workspaceId", "=", workspaceId)
    .executeTakeFirst()
  if (!owned) {
    throw new DeviceModuleError({
      statusCode: 404,
      code: "device_service_not_found",
      message: `device_service ${serviceId} not found on device ${deviceId}`,
    })
  }
  // device_services is a persistent child guarded by sd_reject_delete; the
  // physical detach goes through the SECURITY DEFINER fn (design §7.5/§11).
  await sql`SELECT sd_detach_device_service(${serviceId}::uuid, ${deviceId}::uuid)`.execute(
    db
  )
}
