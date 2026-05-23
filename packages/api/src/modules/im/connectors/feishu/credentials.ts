/**
 * Feishu credentials extraction with alias support.
 *
 * Various callers (lark-cli, manual UI, old import scripts) have written
 * differently-cased forms of the same fields. Normalize to canonical names.
 */

export interface FeishuCredentials {
  appId: string
  appSecret: string
  verificationToken?: string
  encryptKey?: string
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function extractFeishuCredentials(
  credentials: Record<string, unknown> | null | undefined
): { credentials?: FeishuCredentials; errors: string[] } {
  const errors: string[] = []
  const raw = credentials || {}
  const appId =
    nonEmpty(raw.appId) ||
    nonEmpty(raw.appID) ||
    nonEmpty(raw.app_id) ||
    nonEmpty(raw.cliAppId)
  const appSecret =
    nonEmpty(raw.appSecret) ||
    nonEmpty(raw.app_secret) ||
    nonEmpty(raw.cliAppSecret)
  const verificationToken =
    nonEmpty(raw.verificationToken) || nonEmpty(raw.verification_token)
  const encryptKey = nonEmpty(raw.encryptKey) || nonEmpty(raw.encrypt_key)

  if (!appId) errors.push("appId is required")
  if (!appSecret) errors.push("appSecret is required")

  if (errors.length > 0) {
    return { errors }
  }
  return {
    credentials: {
      appId: appId!,
      appSecret: appSecret!,
      verificationToken,
      encryptKey,
    },
    errors: [],
  }
}

export function validateFeishuCredentialsForMode(
  credentials: Record<string, unknown> | null | undefined,
  connectionMode: "webhook" | "long_connection"
): { ok: boolean; errors: string[]; normalized?: FeishuCredentials } {
  const { credentials: c, errors } = extractFeishuCredentials(credentials)
  if (errors.length > 0 || !c) {
    return { ok: false, errors }
  }
  if (connectionMode === "webhook") {
    if (!c.encryptKey) {
      return {
        ok: false,
        errors: ["encryptKey is required for webhook mode"],
        normalized: c,
      }
    }
  }
  return { ok: true, errors: [], normalized: c }
}
