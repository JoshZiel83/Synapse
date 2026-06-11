import { z } from "zod"
import {
  DEVICE_BUILTIN_KINDS,
  DEVICE_EXPOSURE_RUNTIME_STATUSES,
  DEVICE_EXPOSURE_TRANSPORTS,
  DEVICE_PAIRING_MODES,
  DEVICE_SERVICE_KINDS,
  DEVICE_SERVICE_STATUSES,
  DEVICE_TRUST_STATUSES,
  DEVICE_TYPES,
  HOST_KINDS,
} from "@synapse/device-protocol/enums"
import { ScopedSubjectTargetWireSchema } from "@synapse/device-protocol"
import { IsoInstantStringSchema } from "./datetime.js"

/**
 * App-facing camelCase contract for the device-management dashboard
 * (list / detail / capabilities). Source of truth for what web-next and the
 * consumer-side device-sdk read. The signed machine/wire shapes (pairing,
 * bootstrap, control-plane) stay snake_case in @synapse/device-protocol — only
 * these *read views* are app-facing per master plan §2.3-6.
 */

export const DeviceViewSchema = z.strictObject({
  id: z.uuid(),
  workspaceId: z.uuid(),
  title: z.string(),
  hostKind: z.enum(HOST_KINDS),
  hostProvider: z.string().nullable(),
  deviceType: z.enum(DEVICE_TYPES),
  platform: z.string().nullable(),
  trustStatus: z.enum(DEVICE_TRUST_STATUSES),
  lastSeenAt: IsoInstantStringSchema.nullable(),
  lastConnectedAt: IsoInstantStringSchema.nullable(),
})
export type DeviceView = z.infer<typeof DeviceViewSchema>

export const DeviceServiceViewSchema = z.strictObject({
  id: z.uuid(),
  deviceId: z.uuid(),
  serviceKind: z.enum(DEVICE_SERVICE_KINDS),
  version: z.string().nullable(),
  status: z.enum(DEVICE_SERVICE_STATUSES),
  lastSeenAt: IsoInstantStringSchema.nullable(),
  remoteAgentMachineId: z.uuid().nullable(),
})
export type DeviceServiceView = z.infer<typeof DeviceServiceViewSchema>

export const DeviceCapabilityViewSchema = z.strictObject({
  id: z.uuid(),
  workspaceId: z.uuid(),
  exposureId: z.uuid(),
  exposureStableKey: z.string(),
  displayName: z.string(),
  transport: z.enum(DEVICE_EXPOSURE_TRANSPORTS),
  builtinKind: z.enum(DEVICE_BUILTIN_KINDS).nullable(),
  runtimeStatus: z.enum(DEVICE_EXPOSURE_RUNTIME_STATUSES),
  // exposure-level metadata pass-through (provider-defined; open shape).
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
})
export type DeviceCapabilityView = z.infer<typeof DeviceCapabilityViewSchema>

export const DeviceDetailViewSchema = DeviceViewSchema.extend({
  description: z.string().nullable(),
  ownerWorkspaceMemberId: z.uuid().nullable(),
  services: z.array(DeviceServiceViewSchema),
  capabilities: z.array(DeviceCapabilityViewSchema),
})
export type DeviceDetailView = z.infer<typeof DeviceDetailViewSchema>

/**
 * Pairing ticket presented to the dashboard after starting a pairing session.
 * Carries dashboard-only display fields (oneClickCommands, verificationUri*)
 * that the wire `PairingTicket` does not. `bootstrapToken` here is the
 * camelCase app copy handed to web (which injects it into the sandbox env);
 * the snake_case wire `bootstrap_token` stays in device-protocol for the
 * sandbox→/devices/bootstrap handshake.
 */
export const DevicePairingTicketViewSchema = z.strictObject({
  pairingSessionId: z.uuid(),
  mode: z.enum(["local_qr", "cloud_bootstrap", "service_join"]),
  pairingCode: z.string().nullable(),
  bootstrapToken: z.string().nullish(),
  expiresAt: IsoInstantStringSchema,
  verificationUri: z.string().nullable(),
  verificationUriComplete: z.string().nullable(),
  status: z.enum([
    "pending",
    "confirmed",
    "consumed",
    "expired",
    "cancelled",
    "rejected",
  ]),
  oneClickCommands: z
    .strictObject({ unix: z.string(), windows: z.string() })
    .nullish(),
})
export type DevicePairingTicketView = z.infer<
  typeof DevicePairingTicketViewSchema
>

// ============================================================================
// App-facing WRITE-path input contracts (camelCase). Per master plan §5.1.1 /
// §8.3, the request bodies for the device MANAGEMENT methods (createCloudDevice
// / startPairing / claimRemoteAgentDaemon / setActiveDeviceCapabilities) are
// app contracts too — defined here in camelCase, paired with their *View
// result. controller parses with these; web-next + consumer-side device-sdk
// send camelCase bodies. The true wire/handshake inputs (consume / bootstrap)
// stay snake_case in @synapse/device-protocol (device-runtime/sandbox callers).
// ============================================================================

export const CreateCloudDeviceInputSchema = z.strictObject({
  workspaceId: z.uuid(),
  // title/hostProvider are optional: the server applies defaults (title →
  // "Cloud Device", hostProvider → "e2b") when omitted, so the app contract
  // must accept their absence too — otherwise the SDK would reject requests the
  // server happily serves.
  title: z.string().min(1).optional(),
  hostProvider: z.literal("e2b").optional(),
  preset: z.string().optional(),
})
export type CreateCloudDeviceInput = z.infer<
  typeof CreateCloudDeviceInputSchema
>

/**
 * App-facing result of createCloudDevice (camelCase), returned to web which
 * injects `bootstrapToken` into the sandbox env. The snake_case wire copy
 * (device-protocol `CreateCloudDeviceResultSchema.bootstrap_token`) is the
 * separate handshake contract used by the sandbox→/devices/bootstrap exchange;
 * same logical value, two surfaces, two independent contracts (§13.1).
 */
export const CreateCloudDeviceResultViewSchema = z.strictObject({
  pendingDeviceId: z.uuid(),
  bootstrapToken: z.string(),
  pairingSessionId: z.uuid(),
  expiresAt: IsoInstantStringSchema,
})
export type CreateCloudDeviceResultView = z.infer<
  typeof CreateCloudDeviceResultViewSchema
>

export const StartPairingInputSchema = z.strictObject({
  workspaceId: z.uuid(),
  mode: z.enum(DEVICE_PAIRING_MODES),
  title: z.string().optional(),
  deviceType: z.enum(DEVICE_TYPES).optional(),
  // service_join only:
  deviceId: z.uuid().optional(),
  requestedPubkeyFingerprint: z.string().optional(),
  selfChallenge: z.string().optional(),
})
export type StartPairingInput = z.infer<typeof StartPairingInputSchema>

export const ClaimDaemonServiceInputSchema = z.strictObject({
  serviceKind: z.literal("remote_agent_daemon"),
  remoteAgentMachineId: z.uuid(),
})
export type ClaimDaemonServiceInput = z.infer<
  typeof ClaimDaemonServiceInputSchema
>

/**
 * Active-capability binding write. `target` reuses the device-protocol
 * ScopedSubjectTargetWireSchema (already camelCase inner fields + the strict
 * subject/scope whitelist); only `deviceCapabilityIds` is migrated off the
 * legacy snake `device_capability_ids`.
 */
export const SetActiveDeviceCapabilitiesInputSchema = z.strictObject({
  workspaceId: z.uuid(),
  target: ScopedSubjectTargetWireSchema,
  deviceCapabilityIds: z.array(z.uuid()),
  reason: z.string().max(2000).optional(),
})
export type SetActiveDeviceCapabilitiesInput = z.infer<
  typeof SetActiveDeviceCapabilitiesInputSchema
>

/** GET active-capabilities list result for a target (app-facing). */
export const ActiveDeviceCapabilitiesViewSchema = z.strictObject({
  deviceCapabilityIds: z.array(z.uuid()),
})
export type ActiveDeviceCapabilitiesView = z.infer<
  typeof ActiveDeviceCapabilitiesViewSchema
>
