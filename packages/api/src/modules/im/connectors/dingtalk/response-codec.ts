import { z } from "zod"

const dingtalkProviderResponseSchema = z.custom<Record<string, unknown>>(
  (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
)

export interface DingtalkProviderResponse extends Record<string, unknown> {
  accessToken?: unknown
  expireIn?: unknown
  processQueryKey?: unknown
  errcode?: unknown
  errmsg?: unknown
  success?: unknown
  code?: unknown
  subCode?: unknown
}

function parseJsonText(text: string): unknown | null {
  const trimmed = text.trim()
  if (!trimmed) return {}
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

export function parseDingtalkProviderResponseText(
  text: string
): DingtalkProviderResponse | null {
  const json = parseJsonText(text)
  if (json === null) return null
  const parsed = dingtalkProviderResponseSchema.safeParse(json)
  return parsed.success ? parsed.data : null
}

export async function readDingtalkProviderResponse(
  response: Response
): Promise<DingtalkProviderResponse> {
  const text = await response.text().catch(() => "")
  return (
    parseDingtalkProviderResponseText(text) ?? {
      code: "malformed_response",
      errmsg: "DingTalk provider response body is not a JSON object",
    }
  )
}
