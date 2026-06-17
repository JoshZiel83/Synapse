/**
 * QQ webhook Ed25519 signature verification + URL-verification (op=13).
 *
 * Algorithm (sourced from QQ wiki "事件订阅与通知" + cross-checked
 * against the openclaw verifier):
 *
 *   1. seed = botSecret (or clientSecret per OQ1 default), repeated as
 *      necessary to reach 32 bytes (and truncated). This matches the
 *      Go reference: `[]byte(secret), append, append, ... [:32]`.
 *   2. Generate an ed25519 keypair deterministically from the seed.
 *   3. Sign or verify over `timestamp + body` (UTF-8 concatenation).
 *
 * For URL verification (op=13), the platform sends `{plain_token,
 * event_ts}` and expects `{plain_token, signature (hex)}` where the
 * signature is over `event_ts + plain_token`.
 *
 * For business events (op=0), the platform sends `X-Signature-Ed25519`
 * and `X-Signature-Timestamp` headers; the connector verifies the
 * signature is over `timestamp + raw_body`.
 *
 * We use Node's built-in WebCrypto rather than pulling in
 * `@noble/ed25519` because Node 18+ already ships Ed25519 via the
 * Subtle API; this keeps zero new deps and matches Synapse's existing
 * crypto pattern.
 */

import crypto from "node:crypto"

const SEED_LENGTH = 32

function deriveSeed(rawSecret: string): Buffer {
  const buf = Buffer.from(rawSecret, "utf8")
  if (buf.length === SEED_LENGTH) return buf
  if (buf.length === 0) {
    throw new Error("ed25519 seed: empty secret")
  }
  // Repeat the secret until we reach >= 32 bytes, then truncate.
  const padded = Buffer.alloc(SEED_LENGTH)
  let written = 0
  while (written < SEED_LENGTH) {
    const remaining = SEED_LENGTH - written
    const take = Math.min(buf.length, remaining)
    buf.copy(padded, written, 0, take)
    written += take
  }
  return padded
}

/**
 * Derive the ed25519 keypair from the seed and return both keys as
 * KeyObjects. Centralized so seed derivation lives in one place.
 *
 * Node's `crypto.createPrivateKey({ format: "der", type: "pkcs8" })`
 * handles ed25519 via PKCS8 wrap; we build the DER prefix manually.
 */
function createSigningKeys(secret: string): {
  privateKey: crypto.KeyObject
  publicKey: crypto.KeyObject
} {
  const seed = deriveSeed(secret)
  // PKCS8 ed25519 private key DER prefix: 16 bytes (algorithm OID +
  // version) followed by the 32-byte seed wrapped in an OCTET STRING.
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex")
  const der = Buffer.concat([prefix, seed])
  const privateKey = crypto.createPrivateKey({
    key: der,
    format: "der",
    type: "pkcs8",
  })
  const publicKey = crypto.createPublicKey(privateKey)
  return { privateKey, publicKey }
}

/**
 * Sign `eventTs + plainToken` (URL-verification path). Returns a hex
 * string matching the format the platform expects.
 */
export function signEd25519UrlVerification(input: {
  secret: string
  plainToken: string
  eventTs: string
}): string {
  const { privateKey } = createSigningKeys(input.secret)
  const message = Buffer.from(input.eventTs + input.plainToken, "utf8")
  const sig = crypto.sign(null, message, privateKey)
  return sig.toString("hex")
}

/**
 * Verify the platform-issued signature over `signatureTimestamp + rawBody`.
 *
 * `signatureHex` is the value of the `X-Signature-Ed25519` header (hex
 * string). `signatureTimestamp` is the value of `X-Signature-Timestamp`.
 * `rawBody` is the unparsed HTTP body bytes — DO NOT pass the parsed
 * JSON re-serialized; whitespace differences will fail verification.
 */
export function verifyEd25519BusinessEvent(input: {
  secret: string
  signatureHex: string
  signatureTimestamp: string
  rawBody: string
}): boolean {
  if (!input.signatureHex || !input.signatureTimestamp) return false
  let signature: Buffer
  try {
    signature = Buffer.from(input.signatureHex, "hex")
  } catch {
    return false
  }
  if (signature.length !== 64) return false
  // Reject non-canonical signatures (top 3 bits of the final byte must be
  // clear), matching botgo `decodeSigBuffer` (`sig[63]&224 != 0`) and the
  // nonebot adapter. Defense-in-depth alongside crypto.verify's RFC 8032
  // S-range enforcement.
  if ((signature[63]! & 0xe0) !== 0) return false
  const { publicKey } = createSigningKeys(input.secret)
  const message = Buffer.from(input.signatureTimestamp + input.rawBody, "utf8")
  try {
    return crypto.verify(null, message, publicKey, signature)
  } catch {
    return false
  }
}

/**
 * Convenience wrapper for header extraction: pulls the two relevant
 * headers out of a Fastify-style headers record (which can have
 * lowercase or canonical-case keys; arrays for repeated headers).
 */
export function extractSignatureHeaders(headers: Record<string, unknown>): {
  signatureHex: string | undefined
  signatureTimestamp: string | undefined
} {
  const get = (name: string): string | undefined => {
    const v = headers[name.toLowerCase()] ?? headers[name]
    if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : undefined
    return typeof v === "string" ? v : undefined
  }
  return {
    signatureHex: get("X-Signature-Ed25519"),
    signatureTimestamp: get("X-Signature-Timestamp"),
  }
}
