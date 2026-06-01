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
 * Envelope format (versioned): `enc:v2:<saltHex>:<ivHex>:<tagHex>:<ctHex>`
 *
 *   - v2 derives the AES-256 key with scrypt over a per-value random salt, so
 *     the same passphrase never produces the same key twice and there is a
 *     real KDF work factor (the previous scheme used a salt-less single-round
 *     SHA-256, which is not a KDF).
 *   - The version tag lets us evolve the scheme later without ambiguity.
 *
 * The passphrase comes from MCP_ENCRYPTION_KEY (preferred) or APP_SECRET. In
 * production a missing passphrase is a HARD failure (we refuse to silently
 * encrypt with a known default). In development we warn loudly and fall back
 * to an ephemeral process-local key so local dev still works.
 */
const ALGORITHM = "aes-256-gcm"
const IV_LENGTH = 12 // 96-bit nonce, the GCM standard
const SALT_LENGTH = 16
const AUTH_TAG_LENGTH = 16
const KEY_LENGTH = 32 // AES-256
const SCRYPT_PARAMS = { N: 1 << 15, r: 8, p: 1 } as const

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

  const configured = process.env.MCP_ENCRYPTION_KEY || process.env.APP_SECRET
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

function deriveKey(salt: Buffer): Buffer {
  return scryptSync(getPassphrase(), salt, KEY_LENGTH, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    // scrypt's default maxmem (32MiB) is too small for N=2^15; raise it.
    maxmem: 128 * 1024 * 1024,
  })
}

export function encrypt(plaintext: string): string {
  const salt = randomBytes(SALT_LENGTH)
  const iv = randomBytes(IV_LENGTH)
  const key = deriveKey(salt)

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
    salt.toString("hex"),
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
  if (parts.length !== 4) {
    throw new Error("Invalid encrypted value format")
  }
  const [saltHex, ivHex, authTagHex, ciphertextHex] = parts
  const salt = Buffer.from(saltHex, "hex")
  const iv = Buffer.from(ivHex, "hex")
  const authTag = Buffer.from(authTagHex, "hex")
  const ciphertext = Buffer.from(ciphertextHex, "hex")
  const key = deriveKey(salt)

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
