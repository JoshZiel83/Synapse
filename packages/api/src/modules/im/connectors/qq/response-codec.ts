import { z } from "zod"

const qqProviderJsonObjectSchema = z.custom<Record<string, unknown>>(
  (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
)

const qqProviderErrorResponseSchema = z
  .object({
    code: z.number().optional(),
    err_code: z.number().optional(),
    message: z.string().optional(),
    msg: z.string().optional(),
  })
  .passthrough()

const qqSendSuccessResponseSchema = z
  .object({
    id: z.string().min(1).optional(),
    message_id: z.string().min(1).optional(),
    msg_id: z.string().min(1).optional(),
  })
  .passthrough()

const qqUploadSuccessResponseSchema = z
  .object({
    file_info: z.string().min(1),
    file_uuid: z.string().min(1).optional(),
  })
  .passthrough()

export interface QqProviderFailureBody {
  code?: number
  message: string
}

export type QqSendSuccessResponse = z.infer<typeof qqSendSuccessResponseSchema>

export interface QqUploadSuccessResponse {
  fileInfo: string
  fileUuid?: string
}

function parseJsonText(text: string): unknown | null {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function parseQqProviderJsonObjectText(
  text: string
): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed) return {}
  const json = parseJsonText(trimmed)
  if (json === null) return null
  const parsed = qqProviderJsonObjectSchema.safeParse(json)
  return parsed.success ? parsed.data : null
}

export async function readQqProviderJsonObjectResponse(
  response: Response
): Promise<Record<string, unknown>> {
  const text = await response.text().catch(() => "")
  return (
    parseQqProviderJsonObjectText(text) ?? {
      code: "malformed_response",
      message: "QQ provider response body is not a JSON object",
    }
  )
}

export async function readQqProviderSuccessJsonObjectResponse(
  response: Response
): Promise<Record<string, unknown> | null> {
  const text = await response.text().catch(() => "")
  return parseQqProviderJsonObjectText(text)
}

export function parseQqProviderFailureText(
  text: string
): QqProviderFailureBody {
  const json = parseJsonText(text)
  if (json === null) {
    return { message: text.slice(0, 200) }
  }
  const parsed = qqProviderErrorResponseSchema.safeParse(json)
  if (!parsed.success) {
    return { message: text.slice(0, 200) }
  }
  const body = parsed.data
  const code = body.code ?? body.err_code
  const message = body.message ?? body.msg ?? ""
  return code === undefined ? { message } : { code, message }
}

export function extractQqProviderBizCode(text: string): number | undefined {
  const json = parseJsonText(text)
  if (json === null) return undefined
  const parsed = qqProviderErrorResponseSchema.safeParse(json)
  if (!parsed.success) return undefined
  return parsed.data.code ?? parsed.data.err_code
}

export function parseQqSendSuccessResponse(
  json: unknown
): QqSendSuccessResponse | null {
  const parsed = qqSendSuccessResponseSchema.safeParse(json)
  return parsed.success ? parsed.data : null
}

export function extractQqExternalMessageId(json: unknown): string | undefined {
  const parsed = parseQqSendSuccessResponse(json)
  return parsed?.id ?? parsed?.message_id ?? parsed?.msg_id
}

export function parseQqUploadSuccessResponse(
  json: unknown
): QqUploadSuccessResponse | null {
  const parsed = qqUploadSuccessResponseSchema.safeParse(json)
  if (!parsed.success) return null
  if (!parsed.data.file_uuid) {
    return { fileInfo: parsed.data.file_info }
  }
  return {
    fileInfo: parsed.data.file_info,
    fileUuid: parsed.data.file_uuid,
  }
}
