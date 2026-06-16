import { z } from "zod"

const jsonObjectSchema = z.custom<Record<string, unknown>>(
  (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
)

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

type ParsedJsonContent = { parsed: true; value: unknown } | { parsed: false }

function parseJsonContent(content: string): ParsedJsonContent {
  try {
    return { parsed: true, value: JSON.parse(content) }
  } catch {
    return { parsed: false }
  }
}

export function parseFeishuContentObject(
  content: string
): Record<string, unknown> | undefined {
  const json = parseJsonContent(content)
  if (!json.parsed) return undefined
  const parsed = jsonObjectSchema.safeParse(json.value)
  return parsed.success ? parsed.data : undefined
}

export function extractFeishuRawText(
  messageType: string,
  content: string
): string {
  const json = parseJsonContent(content)
  if (json.parsed) {
    if (messageType === "text") {
      const object = jsonObjectSchema.safeParse(json.value)
      return object.success ? nonEmpty(object.data.text) || "" : ""
    }
    if (messageType === "post") {
      return nonEmpty(content) || "[富文本消息]"
    }
    if (messageType === "image") return "[图片]"
    if (messageType === "audio") return "[语音]"
    if (messageType === "video") return "[视频]"
    if (messageType === "file") {
      const object = jsonObjectSchema.safeParse(json.value)
      const fileName = object.success ? nonEmpty(object.data.file_name) : ""
      return fileName ? `[文件 ${fileName}]` : "[文件]"
    }
  } else if (nonEmpty(content)) {
    return content
  }
  return nonEmpty(content) || `[${messageType || "message"}]`
}
