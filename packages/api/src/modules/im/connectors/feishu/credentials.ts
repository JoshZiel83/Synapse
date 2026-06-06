/**
 * Feishu credentials extraction for the current account schema.
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
  const appId = nonEmpty(raw.appId)
  const appSecret = nonEmpty(raw.appSecret)
  const verificationToken = nonEmpty(raw.verificationToken)
  const encryptKey = nonEmpty(raw.encryptKey)

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
