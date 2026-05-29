/**
 * DingTalk credential extraction + validation.
 *
 * Accepts a small set of aliases for clientId/clientSecret so manual
 * pasted credentials from the DingTalk Open Platform (which uses
 * "AppKey" / "AppSecret" labels) and Device-Flow-issued credentials
 * (which use snake_case) both work without a normalization detour.
 */

export interface DingtalkCredentials {
  clientId: string
  clientSecret: string
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function extractDingtalkCredentials(
  credentials: Record<string, unknown> | null | undefined
): { credentials?: DingtalkCredentials; errors: string[] } {
  const errors: string[] = []
  const raw = credentials || {}
  const clientId =
    nonEmpty(raw.clientId) ||
    nonEmpty(raw.client_id) ||
    nonEmpty(raw.appKey) ||
    nonEmpty(raw.app_key) ||
    nonEmpty(raw.AppKey)
  const clientSecret =
    nonEmpty(raw.clientSecret) ||
    nonEmpty(raw.client_secret) ||
    nonEmpty(raw.appSecret) ||
    nonEmpty(raw.app_secret) ||
    nonEmpty(raw.AppSecret)

  if (!clientId) errors.push("clientId is required")
  if (!clientSecret) errors.push("clientSecret is required")

  if (errors.length > 0) {
    return { errors }
  }
  return {
    credentials: { clientId: clientId!, clientSecret: clientSecret! },
    errors: [],
  }
}

export function validateDingtalkCredentialsForMode(
  credentials: Record<string, unknown> | null | undefined,
  connectionMode: "webhook" | "long_connection"
): { ok: boolean; errors: string[]; normalized?: DingtalkCredentials } {
  if (connectionMode === "webhook") {
    return {
      ok: false,
      errors: [
        "DingTalk connector only supports long_connection (Stream) mode in v1",
      ],
    }
  }
  const { credentials: c, errors } = extractDingtalkCredentials(credentials)
  if (errors.length > 0 || !c) {
    return { ok: false, errors }
  }
  return { ok: true, errors: [], normalized: c }
}

export function getDingtalkCredentialsOrThrow(account: {
  credentials?: Record<string, unknown> | null
}): DingtalkCredentials {
  const { credentials, errors } = extractDingtalkCredentials(
    account.credentials
  )
  if (!credentials) {
    throw new Error(`DingTalk credentials missing: ${errors.join(", ")}`)
  }
  return credentials
}
