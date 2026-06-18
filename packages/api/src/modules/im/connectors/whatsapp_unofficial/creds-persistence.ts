/**
 * Baileys session-blob persistence (OD-NEW-C).
 *
 * The Baileys `AuthenticationState` (creds + Signal keys) is a FULL WhatsApp
 * device identity: anyone who can read it can impersonate the number anywhere,
 * and unlike a bot token it is NOT revocable from a dashboard. So we:
 *
 *   1. Serialize the whole `{ creds, keys }` snapshot with Baileys' `BufferJSON`
 *      replacer/reviver (the ONLY correct way to round-trip the Buffer/Uint8Array
 *      fields — plain JSON corrupts the Signal keys → "QR re-requested on
 *      restart" + delivery failures).
 *   2. Encrypt that JSON at rest with the repo's AES-256-GCM envelope
 *      (`infrastructure/crypto`, `enc:v2:…`, keyed off MCP_ENCRYPTION_KEY /
 *      APP_SECRET). In production a missing key is a HARD failure there — we
 *      never store the raw identity blob unencrypted.
 *   3. Store the ciphertext in `transport_accounts.credentials.authBlob` THROUGH
 *      the IM service layer (`updateTransportAccount`) — connectors never touch
 *      the DB directly (guard-layering). This mirrors how weixin persists its
 *      session token via `createTransportAccount`/`updateTransportAccount`.
 *
 * The IM service stores `credentials` as raw JSONB (it does not transparently
 * encrypt), which is exactly why the encryption is applied HERE before the
 * blob ever reaches `updateTransportAccount`.
 */

import {
  BufferJSON,
  initAuthCreds,
  type AuthenticationCreds,
  type SignalDataTypeMap,
} from "baileys"
import {
  decrypt,
  encrypt,
  isEncrypted,
} from "../../../../infrastructure/crypto/index.js"
import { updateTransportAccount } from "../../service.js"

/** The per-key bucket map we persist alongside `creds`. */
export type SignalKeyData = {
  [T in keyof SignalDataTypeMap]?: {
    [id: string]: SignalDataTypeMap[T]
  }
}

export interface AuthSnapshot {
  creds: AuthenticationCreds
  keys: SignalKeyData
}

/** Where the encrypted blob lives inside `transport_accounts.credentials`. */
export const AUTH_BLOB_CREDENTIAL_KEY = "authBlob"

// ───────────────────────── (de)serialization ─────────────────────────

/** Serialize a snapshot to a BufferJSON string (Buffers survive round-trip). */
export function serializeAuthSnapshot(snapshot: AuthSnapshot): string {
  return JSON.stringify(snapshot, BufferJSON.replacer)
}

/** Parse a BufferJSON string back into a snapshot. Throws on malformed input. */
export function deserializeAuthSnapshot(serialized: string): AuthSnapshot {
  const parsed = JSON.parse(serialized, BufferJSON.reviver) as AuthSnapshot
  if (!parsed || typeof parsed !== "object" || !parsed.creds) {
    throw new Error("whatsapp_unofficial: auth snapshot missing creds")
  }
  if (!parsed.keys || typeof parsed.keys !== "object") {
    parsed.keys = {}
  }
  return parsed
}

// ───────────────────────── encrypt / decrypt ─────────────────────────

/** Encrypt a serialized snapshot for at-rest storage. */
export function encryptAuthBlob(serialized: string): string {
  return encrypt(serialized)
}

/** Decrypt a stored blob. Pass-through if it was (legacy) stored unencrypted. */
export function decryptAuthBlob(stored: string): string {
  return isEncrypted(stored) ? decrypt(stored) : stored
}

// ───────────────────────── load / fresh ─────────────────────────

/**
 * Read + decrypt + deserialize a snapshot out of an account's credentials.
 * Returns null when no session has been persisted yet (first login).
 */
export function loadAuthSnapshotFromCredentials(
  credentials: Record<string, unknown> | undefined
): AuthSnapshot | null {
  const stored = credentials?.[AUTH_BLOB_CREDENTIAL_KEY]
  if (typeof stored !== "string" || stored.length === 0) return null
  return deserializeAuthSnapshot(decryptAuthBlob(stored))
}

/** A brand-new auth snapshot (fresh creds, empty key store). */
export function freshAuthSnapshot(): AuthSnapshot {
  return { creds: initAuthCreds(), keys: {} }
}

// ───────────────────────── service-layer write seam ─────────────────────────

/**
 * Persist a snapshot through the IM service layer. Encrypts, then writes to
 * `transport_accounts.credentials.authBlob` via `updateTransportAccount`
 * (credentials are field-merged, so other credential keys are preserved).
 *
 * Injected `update` is the seam tests stub; defaults to the real service call.
 */
export async function persistAuthSnapshot(
  params: {
    workspaceId: string
    accountId: string
    snapshot: AuthSnapshot
  },
  deps: {
    update?: typeof updateTransportAccount
  } = {}
): Promise<void> {
  const update = deps.update ?? updateTransportAccount
  const blob = encryptAuthBlob(serializeAuthSnapshot(params.snapshot))
  await update({
    workspaceId: params.workspaceId,
    accountId: params.accountId,
    expectedTransportKind: "whatsapp_unofficial",
    credentials: { [AUTH_BLOB_CREDENTIAL_KEY]: blob },
  })
}

/**
 * Wipe the persisted session (logged-out / forbidden). Stores an explicit empty
 * marker so a subsequent load returns null and the next start requests a QR.
 */
export async function clearAuthSnapshot(
  params: { workspaceId: string; accountId: string },
  deps: { update?: typeof updateTransportAccount } = {}
): Promise<void> {
  const update = deps.update ?? updateTransportAccount
  await update({
    workspaceId: params.workspaceId,
    accountId: params.accountId,
    expectedTransportKind: "whatsapp_unofficial",
    status: "error",
    credentials: { [AUTH_BLOB_CREDENTIAL_KEY]: "" },
  })
}
