/**
 * Feishu credentials extraction for the current account schema.
 */

export interface FeishuCredentials {
  appId: string
  appSecret: string
  verificationToken?: string
  encryptKey?: string
  /**
   * Which Open Platform the app lives on. "feishu" => open.feishu.cn (China,
   * the default); "lark" => open.larksuite.com (international). The two are
   * region-locked: a Lark app authenticated against open.feishu.cn fails. The
   * SDK defaults to Feishu, so this MUST be threaded into the client for
   * international tenants.
   */
  domain?: "feishu" | "lark"
}

function normalizeDomain(value: unknown): "feishu" | "lark" | undefined {
  const v = nonEmpty(value)?.toLowerCase()
  if (v === "lark" || v === "larksuite") return "lark"
  if (v === "feishu") return "feishu"
  return undefined
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
  const domain = normalizeDomain(raw.domain)

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
      domain,
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
