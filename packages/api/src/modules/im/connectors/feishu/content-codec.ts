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

/**
 * Render one Feishu `post` (rich-text) inline element to plain text.
 * Tags per https://open.feishu.cn/document/.../message-content-description/post .
 */
function renderPostElement(el: Record<string, unknown>): string {
  const tag = typeof el.tag === "string" ? el.tag : ""
  switch (tag) {
    case "text":
    case "md":
    case "code_block":
      return typeof el.text === "string" ? el.text : ""
    case "a": {
      const text = typeof el.text === "string" ? el.text : ""
      const href = typeof el.href === "string" ? el.href : ""
      if (text && href) return `${text} (${href})`
      return text || href
    }
    case "at": {
      const userId = typeof el.user_id === "string" ? el.user_id : ""
      if (userId === "all") return "@all"
      const name =
        typeof el.user_name === "string" && el.user_name.trim()
          ? el.user_name
          : "用户"
      return `@${name}`
    }
    case "img":
      return "[图片]"
    case "media":
      return "[视频]"
    case "emotion":
      return "[表情]"
    case "hr":
      return "---"
    default:
      return typeof el.text === "string" ? el.text : ""
  }
}

/**
 * Flatten a parsed Feishu `post` content object into readable plain text.
 * `post` content is `{ title?, content: [[ {tag,...}, ... ], ... ] }`; some
 * payloads wrap it in a single locale key (`{ zh_cn: { ... } }`), which we
 * unwrap. Paragraphs join with "\n", inline runs join with "" (each run keeps
 * its own spacing). Returns "" when nothing renders so the caller can fall
 * back to a placeholder. Previously the connector returned the raw JSON
 * string here, which leaked `{"title":...,"content":[[...]]}` to the agent.
 */
export function flattenFeishuPost(parsed: Record<string, unknown>): string {
  let root = parsed
  if (!Array.isArray(root.content) && typeof root.title !== "string") {
    // Unwrap an optional single locale layer, e.g. { zh_cn: { title, content } }.
    const localeKeys = Object.keys(root)
    const inner = localeKeys.length ? root[localeKeys[0]] : undefined
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      root = inner as Record<string, unknown>
    }
  }
  const title = typeof root.title === "string" ? root.title.trim() : ""
  const paragraphs = Array.isArray(root.content) ? root.content : []
  const lines: string[] = []
  for (const para of paragraphs) {
    if (!Array.isArray(para)) continue
    const parts: string[] = []
    for (const el of para) {
      if (el && typeof el === "object" && !Array.isArray(el)) {
        const frag = renderPostElement(el as Record<string, unknown>)
        if (frag) parts.push(frag)
      }
    }
    lines.push(parts.join(""))
  }
  const body = lines.join("\n").trim()
  if (title && body) return `${title}\n${body}`
  return title || body
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
      const object = jsonObjectSchema.safeParse(json.value)
      if (!object.success) return "[富文本消息]"
      return flattenFeishuPost(object.data) || "[富文本消息]"
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
