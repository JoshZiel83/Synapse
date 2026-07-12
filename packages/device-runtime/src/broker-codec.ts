import { RUNTIME_SERVICE_KINDS, HOST_KINDS } from "@synapse/device-protocol"
import { z } from "zod"
import type { DeviceIdentityRecord } from "./types.js"

const PersistedKeyEntrySchema = z.strictObject({
  publicKey: z.string().min(1),
  privateKey: z.string().min(1),
  publicKeyFingerprint: z.string().min(1),
})

export type PersistedKeyEntry = z.infer<typeof PersistedKeyEntrySchema>

const KeystoreSchema = z.record(z.string(), PersistedKeyEntrySchema)

const DeviceIdentityServiceSchema = z.strictObject({
  serviceKind: z.enum(RUNTIME_SERVICE_KINDS),
  serviceId: z.string().min(1),
  pubkeyFingerprint: z.string().min(1),
  privateKeyRef: z.string().min(1),
})

const DeviceIdentityRecordSchema = z.strictObject({
  deviceId: z.string().min(1),
  serverOrigin: z.string().min(1),
  hostKind: z.enum(HOST_KINDS),
  services: z.array(DeviceIdentityServiceSchema),
  devicePubkeyFingerprint: z.string().min(1),
  devicePrivateKeyRef: z.string().min(1),
}) satisfies z.ZodType<DeviceIdentityRecord>

export function parseKeystoreJsonText(
  raw: string
): Record<string, PersistedKeyEntry> {
  return KeystoreSchema.parse(JSON.parse(raw))
}

export function parseDeviceIdentityJsonText(raw: string): DeviceIdentityRecord {
  return DeviceIdentityRecordSchema.parse(JSON.parse(raw))
}
