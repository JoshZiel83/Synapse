/**
 * WeCom CanonicalMessage → markdown content renderer.
 *
 * Smart-bot active reply only supports markdown / template_card in v1, so we
 * flatten every CanonicalPart into a single markdown content string suitable
 * for `SendMarkdownMsgBody.markdown.content`. Mention parts render as plain
 * `@name` text (no native at-mention syntax exists). Non-text/mention parts
 * are dropped by the time they reach here — `degradeForCapabilities` has
 * already converted image/file/card to bracketed text per
 * `WECOM_MESSAGE_CAPABILITIES`.
 *
 * Output is truncated to `maxBytes` UTF-8 bytes (default 4096) at a byte
 * boundary, never mid-rune.
 */

import type {
  CanonicalMessage,
  CanonicalPart,
  CanonicalSystemMarker,
} from "../../messaging/canonical-message.js"

const DEFAULT_MAX_BYTES = 4096

const SYSTEM_MARKER_LABELS: Record<CanonicalSystemMarker, string> = {
  image_placeholder: "[图片]",
  voice_placeholder: "[语音]",
  video_placeholder: "[视频]",
  file_placeholder: "[文件]",
  card_placeholder: "[卡片]",
  unknown_placeholder: "[消息]",
}

function renderPart(part: CanonicalPart): string {
  switch (part.type) {
    case "text":
      return part.text
    case "mention":
      return `@${part.displayName}`
    case "system_marker":
      // Image / file / card after degradation arrive as system_marker.
      // Emit the placeholder label (e.g. "[图片]") inline.
      return part.label || SYSTEM_MARKER_LABELS[part.marker]
    default:
      // Anything else is dropped — degradation should have rewritten it.
      return ""
  }
}

/**
 * Truncate `text` to at most `maxBytes` UTF-8 bytes. Truncation backs off
 * to the previous full multi-byte boundary so we never emit a half-rune.
 * (Node's `Buffer.byteLength('字', 'utf8')` is 3.)
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ""
  const buf = Buffer.from(text, "utf8")
  if (buf.byteLength <= maxBytes) return text
  let end = maxBytes
  // Walk back until we land on the start of a UTF-8 rune (top bits != 10).
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end -= 1
  }
  return buf.subarray(0, end).toString("utf8")
}

export function renderWecomMarkdown(
  message: CanonicalMessage,
  maxBytes: number = DEFAULT_MAX_BYTES
): string {
  const content = message.parts.map(renderPart).join("")
  // Empty payload guard: a reaction-only message (or any message whose
  // parts all dropped during degradation) would otherwise render as
  // `""` and result in a `markdown.content: ""` send — WeCom would
  // reject or display blank. Match feishu/weixin's `"[消息]"` fallback.
  return truncateUtf8(content || "[消息]", maxBytes)
}
