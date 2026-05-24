/**
 * Personal-WeChat (ilinkai) credentials extraction.
 *
 * The ilink bot protocol uses a single bearer token; there's no app id /
 * secret split. We surface a baseUrl override for self-hosted gateways.
 */

export interface WeixinCredentials {
  token: string
  baseUrl?: string
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export const DEFAULT_WEIXIN_BASE_URL = "https://ilinkai.weixin.qq.com"

export function extractWeixinCredentials(
  credentials: Record<string, unknown> | null | undefined,
  config: Record<string, unknown> | null | undefined
): { credentials?: WeixinCredentials; errors: string[] } {
  const errors: string[] = []
  const token = nonEmpty(credentials?.token)
  if (!token) errors.push("token is required")
  const baseUrl = nonEmpty(config?.baseUrl) || DEFAULT_WEIXIN_BASE_URL
  if (errors.length > 0) return { errors }
  return { credentials: { token: token!, baseUrl }, errors: [] }
}

export function validateWeixinCredentialsForMode(
  credentials: Record<string, unknown> | null | undefined,
  connectionMode: string,
  config?: Record<string, unknown> | null | undefined
): { ok: boolean; errors: string[]; normalized?: WeixinCredentials } {
  if (connectionMode !== "long_connection") {
    return {
      ok: false,
      errors: [`weixin only supports long_connection (got ${connectionMode})`],
    }
  }
  const { credentials: c, errors } = extractWeixinCredentials(
    credentials,
    config
  )
  if (errors.length > 0 || !c) return { ok: false, errors }
  return { ok: true, errors: [], normalized: c }
}
