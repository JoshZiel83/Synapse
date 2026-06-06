/**
 * DingTalk credential extraction + validation.
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
  const clientId = nonEmpty(raw.clientId)
  const clientSecret = nonEmpty(raw.clientSecret)

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
