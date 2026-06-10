// Device Control Plane hello authentication (§7.1 handshake).
// Verifies that the (device_id, service_id) pair claimed by the runtime is a
// real device_services row in the DB AND that the runtime can sign a
// server-issued nonce with the matching device_service_keys.pubkey.

import { createPublicKey, verify as cryptoVerify } from "node:crypto"
import { db } from "../../infrastructure/database/kysely.js"
import type { KyselyDb } from "../../infrastructure/database/kysely.js"

export interface DeviceHelloAuthInput {
  deviceId: string
  serviceId: string
  signedChallenge: string
  challengeNonce: string
}

export type DeviceHelloAuthResult =
  | {
      ok: true
      deviceId: string
      serviceId: string
      serviceKeyId: string
      pubkeyFingerprint: string
    }
  | {
      ok: false
      code:
        | "device_not_found"
        | "service_not_found"
        | "service_revoked"
        | "service_key_missing"
        | "signature_invalid"
        | "unsupported_key"
      message: string
    }

function decodeBase64(value: string): Buffer | null {
  try {
    const buf = Buffer.from(value, "base64")
    return buf.length === 0 ? null : buf
  } catch {
    return null
  }
}

/**
 * Verify a runtime's device.hello against the DB. On success returns the
 * authenticated device_service_keys.id so the caller can record it on the
 * device_control_plane_sessions row.
 *
 * `executor` defaults to the global `db` singleton; a test injects the
 * testcontainer-backed handle (e.g. the `withTestDb` transaction) so the lookups
 * run against the same isolated schema the test seeded — instead of the global
 * pool, which points at config.database.url and may not exist in CI.
 */
export async function authenticateDeviceHello(
  input: DeviceHelloAuthInput,
  executor: KyselyDb = db
): Promise<DeviceHelloAuthResult> {
  const device = await executor
    .selectFrom("devices")
    .select(["id"])
    .where("id", "=", input.deviceId)
    .executeTakeFirst()
  if (!device) {
    return {
      ok: false,
      code: "device_not_found",
      message: `device ${input.deviceId} not found`,
    }
  }
  const service = await executor
    .selectFrom("deviceServices")
    .select(["id", "deviceId"])
    .where("id", "=", input.serviceId)
    .executeTakeFirst()
  if (!service || (service.deviceId as string) !== input.deviceId) {
    return {
      ok: false,
      code: "service_not_found",
      message: `device_service ${input.serviceId} not found on device ${input.deviceId}`,
    }
  }
  const key = await executor
    .selectFrom("deviceServiceKeys")
    .select(["id", "pubkey", "pubkeyFingerprint", "revokedAt"])
    .where("serviceId", "=", input.serviceId)
    .where("revokedAt", "is", null)
    .executeTakeFirst()
  if (!key) {
    return {
      ok: false,
      code: "service_key_missing",
      message: `no active device_service_keys row for service ${input.serviceId}`,
    }
  }

  const sigBytes = decodeBase64(input.signedChallenge)
  if (!sigBytes) {
    return {
      ok: false,
      code: "signature_invalid",
      message: "signed_challenge must be a non-empty base64 string",
    }
  }
  const nonceBytes = Buffer.from(input.challengeNonce, "utf8")
  let pubKey
  try {
    pubKey = createPublicKey({ key: key.pubkey as string, format: "pem" })
  } catch (err) {
    return {
      ok: false,
      code: "unsupported_key",
      message: `failed to parse pubkey for service ${input.serviceId}: ${(err as Error).message}`,
    }
  }
  let valid: boolean
  try {
    // Ed25519 keys take `null` as the digest argument; RSA/EC would use a
    // string digest name. We standardized on Ed25519 in the broker so any
    // other key type is a client misconfiguration.
    valid = cryptoVerify(null, nonceBytes, pubKey, sigBytes)
  } catch (err) {
    return {
      ok: false,
      code: "signature_invalid",
      message: `signature verify failed: ${(err as Error).message}`,
    }
  }
  if (!valid) {
    return {
      ok: false,
      code: "signature_invalid",
      message: "signature does not match challenge nonce",
    }
  }
  return {
    ok: true,
    deviceId: input.deviceId,
    serviceId: input.serviceId,
    serviceKeyId: key.id as string,
    pubkeyFingerprint: key.pubkeyFingerprint as string,
  }
}
