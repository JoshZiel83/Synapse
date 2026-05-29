// Operation envelope canonical serialization + Ed25519 signing helper.
// Lives in device-protocol so both the API (signs) and the device runtime
// (verifies) use identical canonicalization. The signed payload is the
// canonical JSON of the envelope minus the `signature` field; `signature_kid`
// IS included so attackers can't downgrade to a key under their control.

import { createPrivateKey, sign as cryptoSign } from "node:crypto"
import type { OperationEnvelope } from "./schemas.js"

export function canonicalizeEnvelopePayload(value: unknown): string {
  if (value === undefined) return "null"
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeEnvelopePayload).join(",")}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalizeEnvelopePayload(obj[k])}`)
    .join(",")}}`
}

export type UnsignedOperationEnvelope = Omit<OperationEnvelope, "signature">

/**
 * Sign an envelope payload with an Ed25519 private key (PEM-encoded). Returns
 * the base64 signature that the caller embeds in `envelope.signature` before
 * shipping to the device.
 */
export function signOperationEnvelopePayload(
  payload: UnsignedOperationEnvelope,
  privateKeyPem: string
): string {
  const canonical = canonicalizeEnvelopePayload({
    ...payload,
    signature: undefined,
  })
  const key = createPrivateKey({ key: privateKeyPem, format: "pem" })
  const sig = cryptoSign(null, Buffer.from(canonical, "utf8"), key)
  return sig.toString("base64")
}

/** Convenience: takes a payload + key, returns the full signed envelope. */
export function signOperationEnvelope(
  payload: UnsignedOperationEnvelope,
  privateKeyPem: string
): OperationEnvelope {
  const signature = signOperationEnvelopePayload(payload, privateKeyPem)
  return { ...payload, signature }
}
