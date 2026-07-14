import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto"

import { createLogger } from "../logger/index.js"

const log = createLogger("crypto")

/**
 * Sensitive-field encryption at rest (MCP plugin configs, IM credentials, …).
 *
 * Envelope format (versioned): `enc:v2:<ivHex>:<tagHex>:<ctHex>`
 *
 *   - The AES-256 key is derived ONCE per process with scrypt over the master
 *     passphrase + a fixed application salt, then memoized. scrypt is expensive
 *     (~250ms) BY DESIGN, so we must not run it per encrypt/decrypt on the
 *     request path — deriving once and reusing the key is the standard
 *     master-key + per-message-nonce envelope pattern.
 *   - Semantic security comes from a fresh random 96-bit IV per value (GCM),
 *     not from a per-value KDF salt.
 *   - The version tag lets us evolve the scheme later without ambiguity.
 *
 * The passphrase comes from MCP_ENCRYPTION_KEY (preferred) or APP_SECRET. In
 * production a missing passphrase is a HARD failure (we refuse to silently
 * encrypt with a known default). In development we warn loudly and fall back
 * to an ephemeral process-local key so local dev still works.
 */
const ALGORITHM = "aes-256-gcm"
const IV_LENGTH = 12 // 96-bit nonce, the GCM standard
const AUTH_TAG_LENGTH = 16
const KEY_LENGTH = 32 // AES-256
const SCRYPT_PARAMS = { N: 1 << 15, r: 8, p: 1 } as const
// Fixed application salt for the master-key derivation. A salt's job in a KDF
// is to make identical inputs derive different keys across contexts; for a
// single server-side master passphrase a constant app salt is the norm (this
// is not per-user password hashing). It must stay stable or existing
// ciphertext becomes undecryptable.
const APP_KDF_SALT = Buffer.from("synapse:mcp-secret-encryption:v2", "utf8")

const ENCRYPTED_PREFIX = "enc:"
const ENVELOPE_VERSION = "v2"
const V2_PREFIX = `${ENCRYPTED_PREFIX}${ENVELOPE_VERSION}:`

/**
 * Resolve the master passphrase. Memoized so the dev-fallback warning fires
 * once and the ephemeral dev key is stable for the process lifetime (so values
 * encrypted earlier in the run can be decrypted later in the same run).
 */
let cachedPassphrase: string | null = null

function getPassphrase(): string {
  if (cachedPassphrase !== null) return cachedPassphrase

  // #15: select the first source whose TRIMMED value is non-empty — a
  // whitespace-only MCP_ENCRYPTION_KEY must neither pass as a "configured" key
  // nor shadow a real APP_SECRET. But derive from the ORIGINAL untrimmed value:
  // trimming the scrypt input would change the passphrase for every deployment
  // whose key carries surrounding whitespace and orphan all data already
  // encrypted at rest. (config's superRefine rejects a trimmed-empty key at boot
  // in production, so this selection matches the boot gate.)
  const rawMcpKey = process.env.MCP_ENCRYPTION_KEY
  const rawAppSecret = process.env.APP_SECRET
  let configured: string | undefined
  if (rawMcpKey?.trim()) {
    configured = rawMcpKey
  } else if (rawAppSecret?.trim()) {
    configured = rawAppSecret
  }
  if (configured) {
    cachedPassphrase = configured
    return cachedPassphrase
  }

  const isProd = (process.env.NODE_ENV || "development") === "production"
  if (isProd) {
    // Fail fast: never encrypt production secrets under a guessable key.
    throw new Error(
      "Refusing to start: neither MCP_ENCRYPTION_KEY nor APP_SECRET is set. " +
        "One is required in production to encrypt sensitive plugin/IM " +
        "credentials at rest."
    )
  }

  // Development convenience: ephemeral per-process key + a loud warning.
  cachedPassphrase = randomBytes(32).toString("hex")
  log.warn(
    "MCP_ENCRYPTION_KEY/APP_SECRET not set — using an EPHEMERAL dev key. " +
      "Encrypted values will NOT be readable across restarts. Set " +
      "MCP_ENCRYPTION_KEY before storing anything you need to persist."
  )
  return cachedPassphrase
}

/**
 * The AES key, derived once and memoized. The expensive scrypt KDF runs on the
 * FIRST encrypt/decrypt only, never per call.
 */
let cachedKey: Buffer | null = null

function getKey(): Buffer {
  if (cachedKey !== null) return cachedKey
  cachedKey = scryptSync(getPassphrase(), APP_KDF_SALT, KEY_LENGTH, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    // scrypt's default maxmem (32MiB) is too small for N=2^15; raise it.
    maxmem: 128 * 1024 * 1024,
  })
  return cachedKey
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH)
  const key = getKey()

  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  })
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()

  return [
    `${ENCRYPTED_PREFIX}${ENVELOPE_VERSION}`, // "enc:v2"
    iv.toString("hex"),
    authTag.toString("hex"),
    ciphertext.toString("hex"),
  ].join(":")
}

export function decrypt(encryptedValue: string): string {
  if (!encryptedValue.startsWith(V2_PREFIX)) {
    if (encryptedValue.startsWith(ENCRYPTED_PREFIX)) {
      throw new Error("Unsupported encryption envelope version")
    }
    // Not encrypted — return as-is (callers store mixed plain/encrypted maps).
    return encryptedValue
  }

  const parts = encryptedValue.slice(V2_PREFIX.length).split(":")
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted value format")
  }
  const [ivHex, authTagHex, ciphertextHex] = parts
  const iv = Buffer.from(ivHex, "hex")
  const authTag = Buffer.from(authTagHex, "hex")
  const ciphertext = Buffer.from(ciphertextHex, "hex")
  const key = getKey()

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  })
  decipher.setAuthTag(authTag)
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ])
  return plaintext.toString("utf8")
}

// ── AAD-bound envelope (base64) ───────────────────────────────────────────────
// A second envelope shape for callers that must BIND the ciphertext to a
// specific record identity via AES-GCM Additional Authenticated Data (AAD).
// Reuses the SAME master key (getKey → MCP_ENCRYPTION_KEY, prod-fail-closed), so
// there is no new key management — only the wire shape + the AAD differ:
//   `enc:b1:<base64(nonce ‖ ciphertext ‖ authTag)>`
// The AAD is authenticated but NOT encrypted; a decrypt with a different AAD
// fails the GCM tag check (throws), which is exactly the anti-swap property the
// sandbox data-plane creds rely on (§6.7/3b): a blob written for row A cannot be
// pasted onto row B and decrypt.
const AAD_ENVELOPE_VERSION = "b1"
const AAD_PREFIX = `${ENCRYPTED_PREFIX}${AAD_ENVELOPE_VERSION}:` // "enc:b1:"

/** Encrypt `plaintext` under the app master key, binding `aad` into the GCM tag.
 *  Returns the `enc:b1:<base64>` envelope. */
export function encryptWithAad(plaintext: string, aad: string): string {
  const iv = randomBytes(IV_LENGTH)
  const key = getKey()
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  })
  cipher.setAAD(Buffer.from(aad, "utf8"))
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()
  return `${AAD_PREFIX}${Buffer.concat([iv, ciphertext, authTag]).toString("base64")}`
}

/** Decrypt an `enc:b1:` envelope, requiring the SAME `aad` used to encrypt.
 *  THROWS on any mismatch (wrong AAD, wrong key, tampered/corrupt bytes) — the
 *  caller decides whether that is fatal or a degrade-to-null. */
export function decryptWithAad(envelope: string, aad: string): string {
  if (!envelope.startsWith(AAD_PREFIX)) {
    throw new Error("Unsupported AAD encryption envelope")
  }
  const raw = Buffer.from(envelope.slice(AAD_PREFIX.length), "base64")
  if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Invalid AAD envelope: too short")
  }
  const iv = raw.subarray(0, IV_LENGTH)
  const authTag = raw.subarray(raw.length - AUTH_TAG_LENGTH)
  const ciphertext = raw.subarray(IV_LENGTH, raw.length - AUTH_TAG_LENGTH)
  const key = getKey()
  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  })
  decipher.setAAD(Buffer.from(aad, "utf8"))
  decipher.setAuthTag(authTag)
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8")
}

export function encryptSensitiveFields(
  config: Record<string, unknown>,
  schema: Record<string, unknown>
): Record<string, unknown> {
  if (!schema || !config) return config

  const properties = (schema as any).properties as
    | Record<string, any>
    | undefined
  if (!properties) return config

  const result = { ...config }

  for (const [key, value] of Object.entries(result)) {
    if (
      properties[key]?.sensitive === true &&
      typeof value === "string" &&
      value.length > 0 &&
      !isEncrypted(value)
    ) {
      result[key] = encrypt(value)
    }
  }

  return result
}

export function decryptSensitiveFields(
  config: Record<string, unknown>
): Record<string, unknown> {
  if (!config) return config

  const result = { ...config }

  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "string" && isEncrypted(value)) {
      try {
        result[key] = decrypt(value)
      } catch (error) {
        // If decryption fails (e.g. the key changed), leave the ciphertext in
        // place but surface it — silently returning the ciphertext as a
        // "value" was how key-rotation bugs went unnoticed before.
        log.error(
          { key, err: error },
          "failed to decrypt sensitive field; leaving value encrypted"
        )
      }
    }
  }

  return result
}

export function isEncrypted(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(ENCRYPTED_PREFIX)
}

/**
 * Constant-time comparison of two UTF-8 secrets. Exposed so callers stop
 * hand-rolling timingSafeEqual length-guards.
 */
export function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8")
  const bb = Buffer.from(b, "utf8")
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
