// (R4 §1.3 / §6.7) Off-box data-plane credential envelope + redaction.
//
// An off-box adapter (cubesandbox:bare) captures a per-sandbox envd/traffic
// access token at create(). We persist it — encrypted — on
// `sandboxes.data_plane_credentials_encrypted` so a rebuild-on-restart /
// reconnect can re-inject it (a synchronous rebuild can't re-mint). This module
// owns three concerns:
//
//   1. ENCRYPT/DECRYPT — reuse the app secret-box (AES-256-GCM under
//      MCP_ENCRYPTION_KEY, prod-fail-closed) with the AAD bound to the row
//      identity (§6.7/3b) so a DB-write attacker can't swap a cred blob between
//      rows: a blob written for row A fails the GCM tag on row B → null → the
//      reconnect re-mint heals it (F7), never a fleet-wide hard-deny.
//   2. F7 DEGRADE — a decrypt MISS (rotated key, tampered AAD, corrupt bytes)
//      returns null, NEVER throws to the dispatch path.
//   3. REDACTION (§6.7/3d) — brand the in-memory bag so a stray `log({handle})`
//      or error-serialize can't leak the tokens: the secret fields are
//      NON-ENUMERABLE (still readable by the envd/encrypt paths that NAME them)
//      and toJSON / util.inspect return a redaction marker.

import {
  decryptWithAad,
  encryptWithAad,
} from "../../infrastructure/crypto/index.js"
import { createLogger } from "../../infrastructure/logger/index.js"
import type { SandboxDataPlaneCredentials } from "./sandbox-lifecycle.js"

const log = createLogger("sandbox.credentials")

const REDACTED = "[SandboxDataPlaneCredentials redacted]"

/** The binding that scopes an envelope to ONE sandboxes row (§6.7/3b). Both
 *  values are authoritative at encrypt (mint) AND decrypt (repo exit / reconnect):
 *  `sandboxRowId` == `sandboxes.id` (== runtimes.id), workspaceId == sandboxes.workspace_id. */
export interface SandboxCredentialBinding {
  sandboxRowId: string
  workspaceId: string
}

function credentialAad(binding: SandboxCredentialBinding): string {
  return `sandbox-dpc:v1:${binding.sandboxRowId}:${binding.workspaceId}`
}

/** True when the bag actually carries a secret worth persisting. Host/resident
 *  adapters + the UNAUTHENTICATED local cube (create returns no tokens) have
 *  none — the column stays NULL. */
export function hasAnyToken(
  creds: SandboxDataPlaneCredentials | null | undefined
): boolean {
  if (!creds) return false
  return Boolean(
    creds.envdAccessToken ||
    creds.trafficAccessToken ||
    (creds.extra && Object.keys(creds.extra).length > 0)
  )
}

/**
 * Brand a credentials bag so it cannot leak through a log / JSON.stringify /
 * util.inspect (§6.7/3d). The token fields stay READABLE by name (the envd
 * factory + encrypt read `creds.envdAccessToken` directly) but are
 * NON-ENUMERABLE, and toJSON / the node inspect hook return a redaction marker.
 */
export function brandRedactedCredentials(raw: {
  envdAccessToken?: string
  trafficAccessToken?: string
  extra?: Record<string, string>
}): SandboxDataPlaneCredentials {
  const creds = {} as SandboxDataPlaneCredentials
  const hide = (key: PropertyKey, value: unknown): void => {
    Object.defineProperty(creds, key, {
      value,
      enumerable: false,
      writable: false,
      configurable: false,
    })
  }
  hide("envdAccessToken", raw.envdAccessToken)
  hide("trafficAccessToken", raw.trafficAccessToken)
  hide("extra", raw.extra)
  hide("toJSON", () => REDACTED)
  hide(Symbol.for("nodejs.util.inspect.custom"), () => REDACTED)
  return creds
}

/** A plain `{ envdAccessToken, trafficAccessToken }` for the envd factory (which
 *  reads the two fields). Safe to build from a branded bag (fields are readable). */
export function tokensForEnvd(
  creds: SandboxDataPlaneCredentials | null | undefined
): { envdAccessToken?: string; trafficAccessToken?: string } | undefined {
  if (!hasAnyToken(creds)) return undefined
  return {
    envdAccessToken: creds?.envdAccessToken,
    trafficAccessToken: creds?.trafficAccessToken,
  }
}

/**
 * Encrypt to the base64 envelope for `sandboxes.data_plane_credentials_encrypted`
 * (§1.3/3c). Returns null when there is no secret to persist — so the column
 * stays NULL for host/resident + the unauthenticated local cube.
 */
export function encodeSandboxDataPlaneCredentials(
  creds: SandboxDataPlaneCredentials | null | undefined,
  binding: SandboxCredentialBinding
): string | null {
  if (!hasAnyToken(creds)) return null
  const plaintext = JSON.stringify({
    envdAccessToken: creds?.envdAccessToken,
    trafficAccessToken: creds?.trafficAccessToken,
    extra: creds?.extra,
  })
  return encryptWithAad(plaintext, credentialAad(binding))
}

/**
 * Decrypt the persisted envelope (§1.3, F7). A MISS — rotated key, tampered AAD
 * (blob swapped onto another row), or genuinely corrupt bytes — returns null and
 * NEVER throws, so the caller degrades to a token-less/re-mint heal instead of a
 * hard-deny. This is a security/robustness fail-safe, NOT old-data tolerance:
 * there is one envelope format (`enc:b1:`), so a well-formed current blob always
 * decrypts. Returns a BRANDED (redacted) bag on success.
 */
export function decodeSandboxDataPlaneCredentials(
  envelope: string | null | undefined,
  binding: SandboxCredentialBinding
): SandboxDataPlaneCredentials | null {
  if (!envelope) return null
  try {
    const parsed = JSON.parse(
      decryptWithAad(envelope, credentialAad(binding))
    ) as {
      envdAccessToken?: unknown
      trafficAccessToken?: unknown
      extra?: unknown
    }
    return brandRedactedCredentials({
      envdAccessToken:
        typeof parsed.envdAccessToken === "string"
          ? parsed.envdAccessToken
          : undefined,
      trafficAccessToken:
        typeof parsed.trafficAccessToken === "string"
          ? parsed.trafficAccessToken
          : undefined,
      extra:
        parsed.extra && typeof parsed.extra === "object"
          ? (parsed.extra as Record<string, string>)
          : undefined,
    })
  } catch (err) {
    // F7: degrade to null — the reconnect re-mint heals it (§6.7). Log without
    // the ciphertext or binding secrets.
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "data-plane credentials decrypt miss → degrading to null (F7)"
    )
    return null
  }
}
