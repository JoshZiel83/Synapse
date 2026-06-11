import { z } from "zod"
import {
  DEVICE_BUILTIN_KINDS,
  DEVICE_EXPOSURE_RUNTIME_STATUSES,
  DEVICE_EXPOSURE_TRANSPORTS,
  DEVICE_SERVICE_KINDS,
  DEVICE_SERVICE_STATUSES,
  DEVICE_TRUST_STATUSES,
  DEVICE_TYPES,
  HOST_KINDS,
} from "@synapse/device-protocol/enums"
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
