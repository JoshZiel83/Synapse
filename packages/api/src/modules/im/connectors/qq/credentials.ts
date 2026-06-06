/**
 * QQ official-bot credentials extraction.
 *
 * The QQ open platform issues two tokens against the same app:
 *   - `appId` — public identifier (e.g. "102001234")
 *   - `clientSecret` — used to obtain a bearer access_token via
 *     `POST https://bots.qq.com/app/getAppAccessToken` (the "OpenAPI"
 *     credential)
 *
 * OQ1 (open question, see plan): the platform's webhook docs reference a
 * separate `botSecret` used as the Ed25519 seed for signature
 * verification. In practice on the current sandbox these are the same
 * string; until we have explicit confirmation, this schema accepts an
 * optional `botSecret` and falls back to `clientSecret` when omitted.
 * The fallback is documented per-field below so reviewers don't have
 * to dig into the wiki.
 *
 */

export interface QqCredentials {
  appId: string
  clientSecret: string
  /**
   * Ed25519 signing seed for webhook signature verification. When
   * omitted, `clientSecret` is used as the seed (per OQ1 default).
   * Stored separately so flipping the assumption later is a config
   * change, not a credential migration.
   */
  botSecret?: string
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function extractQqCredentials(
  credentials: Record<string, unknown> | null | undefined
): { credentials?: QqCredentials; errors: string[] } {
  const errors: string[] = []
  const raw = credentials || {}
  const appId = nonEmpty(raw.appId)
  const clientSecret = nonEmpty(raw.clientSecret)
  const botSecret = nonEmpty(raw.botSecret)

  if (!appId) errors.push("appId is required")
  if (!clientSecret) errors.push("clientSecret is required")
  if (errors.length > 0) return { errors }

  const out: QqCredentials = { appId: appId!, clientSecret: clientSecret! }
  if (botSecret) out.botSecret = botSecret
  return { credentials: out, errors: [] }
}

/**
 * Wrap extraction with connection-mode constraint. QQ supports both
 * webhook and long_connection; the only mode that REQUIRES `botSecret`
 * explicitly would be webhook IF OQ1 resolves to "they're different".
 * For now we don't enforce that — extraction always returns a normalized
 * record and downstream code uses `botSecret ?? clientSecret` for the
 * Ed25519 seed.
 */
export function validateQqCredentialsForMode(
  credentials: Record<string, unknown> | null | undefined,
  connectionMode: string
): { ok: boolean; errors: string[]; normalized?: QqCredentials } {
  if (connectionMode !== "webhook" && connectionMode !== "long_connection") {
    return {
      ok: false,
      errors: [`qq supports webhook | long_connection (got ${connectionMode})`],
    }
  }
  const { credentials: c, errors } = extractQqCredentials(credentials)
  if (errors.length > 0 || !c) return { ok: false, errors }
  return { ok: true, errors: [], normalized: c }
}

/**
 * Read access for downstream connector code (e.g. the inbound webhook
 * verifier, the WebSocket gateway client). Throws on missing creds so
 * the caller doesn't have to thread Result types through every helper.
 */
export function getQqCredentialsOrThrow(account: {
  credentials?: Record<string, unknown>
}): QqCredentials {
  const { credentials, errors } = extractQqCredentials(account.credentials)
  if (!credentials) {
    throw new Error(`QQ credentials invalid: ${errors.join(", ")}`)
  }
  return credentials
}

/**
 * Signing seed for Ed25519 webhook verification. Per OQ1 default,
 * `botSecret` falls back to `clientSecret`. Centralized here so the
 * fallback choice is one line to change.
 */
export function getEd25519Seed(creds: QqCredentials): string {
  return creds.botSecret ?? creds.clientSecret
}
