// Runtime Control Plane hello authentication (§7.1 handshake).
// Verifies that the (runtime_id, service_id) pair claimed by the runtime is a
// real runtime_services row in the DB AND that the runtime can sign a
// server-issued nonce with the matching runtime_service_keys.pubkey.

import { createPublicKey, verify as cryptoVerify } from "node:crypto"
import type { KyselyDb } from "../../infrastructure/database/kysely.js"
import { selectRuntimeHelloAuthContext } from "./repo.js"

export interface RuntimeHelloAuthInput {
  runtimeId: string
  serviceId: string
  signedChallenge: string
  challengeNonce: string
}

export type RuntimeHelloAuthResult =
  | {
      ok: true
      runtimeId: string
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
 * authenticated runtime_service_keys.id so the caller can record it on the
 * runtime_control_plane_sessions row.
 *
 * `executor` is optional; the repo lookup defaults to the global DB singleton.
 * Tests inject the testcontainer-backed handle (e.g. the `withTestDb`
 * transaction) so lookups run against the same isolated schema they seeded.
 */
export async function authenticateRuntimeHello(
  input: RuntimeHelloAuthInput,
  executor?: KyselyDb
): Promise<RuntimeHelloAuthResult> {
  const context = await selectRuntimeHelloAuthContext(input, executor)
  if (!context.runtimeExists) {
    return {
      ok: false,
      code: "device_not_found",
      message: `device ${input.runtimeId} not found`,
    }
  }
  if (!context.service) {
    return {
      ok: false,
      code: "service_not_found",
      message: `device_service ${input.serviceId} not found on device ${input.runtimeId}`,
    }
  }
  const key = context.activeKey
  if (!key) {
    return {
      ok: false,
      code: "service_key_missing",
      message: `no active runtime_service_keys row for service ${input.serviceId}`,
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
    pubKey = createPublicKey({ key: key.pubkey, format: "pem" })
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
    runtimeId: input.runtimeId,
    serviceId: input.serviceId,
    serviceKeyId: key.id,
    pubkeyFingerprint: key.pubkeyFingerprint,
  }
}
