/**
 * WhatsApp Cloud API credential extraction + validation.
 *
 * Cloud API auth is a bundle of plaintext-JSONB fields (all revocable —
 * OD-8):
 *   - phoneNumberId    — the WABA phone-number id messages are sent from
 *   - wabaId           — WhatsApp Business Account id (used for template ops,
 *                        out of scope here; kept for completeness)
 *   - accessToken      — System User token (permanent) — Bearer for Graph
 *   - appSecret        — used to verify the X-Hub-Signature-256 webhook HMAC
 *   - appId            — Meta App id
 *   - webhookVerifyToken — the shared secret echoed in the GET hub.challenge
 *                          handshake
 *   - graphApiVersion  — defaults to v23.0
 *
 * `validateWhatsappCredentialsForMode` is SYNCHRONOUS (matches the connector
 * contract; any live phoneNumberId probe lives in the controller route, not
 * here). It validates SHAPE only.
 */

import { WHATSAPP_DEFAULT_GRAPH_VERSION } from "./types.js"

export interface WhatsappCredentials {
  phoneNumberId: string
  wabaId: string
  accessToken: string
  appSecret: string
  appId: string
  webhookVerifyToken: string
  /** e.g. "v23.0" — defaulted when omitted. */
  graphApiVersion: string
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/**
 * Normalize a graph version string: accept "v23.0" or "23.0" and always
 * return the "v"-prefixed form. Invalid shapes fall back to the default.
 */
function normalizeGraphVersion(raw: unknown): string {
  const v = nonEmpty(raw)
  if (!v) return WHATSAPP_DEFAULT_GRAPH_VERSION
  const withV = v.startsWith("v") ? v : `v${v}`
  // Must look like vNN or vNN.N — otherwise default rather than letting a
  // garbage segment build a broken URL.
  return /^v\d+(\.\d+)?$/.test(withV) ? withV : WHATSAPP_DEFAULT_GRAPH_VERSION
}

export function extractWhatsappCredentials(
  credentials: Record<string, unknown> | null | undefined
): { credentials?: WhatsappCredentials; errors: string[] } {
  const errors: string[] = []
  const raw = credentials || {}

  const phoneNumberId = nonEmpty(raw.phoneNumberId)
  const wabaId = nonEmpty(raw.wabaId)
  const accessToken = nonEmpty(raw.accessToken)
  const appSecret = nonEmpty(raw.appSecret)
  const appId = nonEmpty(raw.appId)
  const webhookVerifyToken = nonEmpty(raw.webhookVerifyToken)
  const graphApiVersion = normalizeGraphVersion(raw.graphApiVersion)

  if (!phoneNumberId) errors.push("phoneNumberId is required")
  if (!wabaId) errors.push("wabaId is required")
  if (!accessToken) errors.push("accessToken is required")
  if (!appSecret) errors.push("appSecret is required")
  if (!appId) errors.push("appId is required")
  if (!webhookVerifyToken) errors.push("webhookVerifyToken is required")
  if (errors.length > 0) return { errors }

  return {
    credentials: {
      phoneNumberId: phoneNumberId!,
      wabaId: wabaId!,
      accessToken: accessToken!,
      appSecret: appSecret!,
      appId: appId!,
      webhookVerifyToken: webhookVerifyToken!,
      graphApiVersion,
    },
    errors: [],
  }
}

/**
 * Connection-mode-aware credential validation. Cloud API is WEBHOOK-only;
 * any other mode is rejected with a stable message. Returns the normalized
 * record (so `graphApiVersion` is filled with the default) on success.
 */
export function validateWhatsappCredentialsForMode(
  credentials: Record<string, unknown> | null | undefined,
  connectionMode: string
): { ok: boolean; errors: string[]; normalized?: WhatsappCredentials } {
  if (connectionMode !== "webhook") {
    return {
      ok: false,
      errors: [
        `whatsapp (Cloud API) supports webhook only (got ${connectionMode})`,
      ],
    }
  }
  const { credentials: c, errors } = extractWhatsappCredentials(credentials)
  if (errors.length > 0 || !c) return { ok: false, errors }
  return { ok: true, errors: [], normalized: c }
}

/**
 * Read access for downstream connector code (client / webhook verifier /
 * media). Throws on missing creds so callers don't thread Result types.
 */
export function getWhatsappCredentialsOrThrow(account: {
  credentials?: Record<string, unknown>
}): WhatsappCredentials {
  const { credentials, errors } = extractWhatsappCredentials(
    account.credentials
  )
  if (!credentials) {
    throw new Error(`WhatsApp credentials invalid: ${errors.join(", ")}`)
  }
  return credentials
}
