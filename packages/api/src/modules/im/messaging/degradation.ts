/**
 * Per-capability message degradation.
 *
 * Given a CanonicalMessage and the destination transport's MessageCapabilities,
 * returns a new CanonicalMessage with parts rewritten to fit what the
 * transport can actually deliver (e.g. drop card → fallbackText for WeChat).
 *
 * Pure function. Does not mutate input.
 *
 * The MessageCapabilities type is owned here; per-connector instances live in
 * `connectors/<kind>/capabilities.ts` and are the single source of truth at
 * runtime. Do NOT add named capability constants here — tests should import
 * from the connector files so they exercise the same descriptor the runtime
 * uses.
 */

import {
  buildCanonicalMessage,
  type CanonicalMessage,
  type CanonicalPart,
} from "./canonical-message.js"

export interface MessageCapabilities {
  canEdit: boolean
  canReact: boolean
  canTyping: boolean
  canSendCard: boolean
  canStream: boolean
  supportsGroup: boolean
  supportsMention: boolean
  supportsReply: boolean
  supportsImage: boolean
  supportsFile: boolean
  /**
   * Voice messages (audio_silk / audio_mp3 parts). False on every
   * platform that doesn't currently implement audio render/upload —
   * leaving this true would let voice parts reach `sendMessage` and
   * silently fail. Enable per-connector only when actual upload path
   * lands.
   */
  supportsVoice: boolean
  /**
   * Short-video messages. Same conservative default as `supportsVoice`.
   */
  supportsVideo: boolean
  /**
   * Inline interaction prompts (buttons / inline keyboard /
   * runtime-authorization prompt projection). For QQ this is Inline
   * Keyboard + INTERACTION_CREATE. Connectors that opt in receive
   * `interaction_prompt` canonical parts; others see them degrade
   * away (rewritten to the part's `fallbackText`). The
   * `interaction-projection` worker uses this flag plus the optional
   * `getInteractionProjectionReadiness?()` hook as the dispatch gate
   * (replaces the per-kind worker hard-code).
   */
  supportsInteractionPrompt: boolean
  maxTextBytes: number
  /**
   * How to pick the recipient address for a mention sent to a direct (1:1)
   * endpoint.
   *
   *   - `"attached_only"`: only addresses already attached to the mentioned
   *     participant in this conversation are valid. Used by platforms where
   *     the bot can only @ users it has previously seen speak (Feishu).
   *
   *   - `"self_only"`: the only addressable peer in a direct chat is the
   *     endpoint's externalId itself. Used by platforms where 1:1 chats
   *     contain exactly one human (personal WeChat).
   *
   * Group endpoints always require attached-only resolution regardless of
   * this flag, since group mentions must be people who actually exist in
   * the group.
   */
  directMentionPolicy: "attached_only" | "self_only"
}

/**
 * Degrade a message for delivery to a transport with limited capabilities.
 *
 * Rules (per part type, applied independently):
 *   - text: kept; truncated to caps.maxTextBytes when exceeded (suffix "…")
 *   - mention: kept if supportsMention, else flattened to "@displayName" text
 *   - image: kept if supportsImage, else replaced by a system_marker
 *   - file: kept if supportsFile, else replaced by "[文件 name]" text
 *   - card: kept if supportsSendCard, else replaced by fallbackText
 *   - quote: kept if supportsReply, else flattened to "> {preview}\n"
 *   - reaction: kept if canReact, else dropped silently
 *   - system_marker: kept as-is
 *
 * Adjacent text parts are NOT auto-merged here; callers can do so if needed.
 * Returns a new CanonicalMessage with recomputed plainText.
 */
export function degradeForCapabilities(
  msg: CanonicalMessage,
  caps: MessageCapabilities
): CanonicalMessage {
  const out: CanonicalPart[] = []
  for (const part of msg.parts) {
    const replacements = degradePart(part, caps)
    for (const replacement of replacements) {
      out.push(replacement)
    }
  }
  const merged = mergeAdjacentText(out)
  const capped = capTextParts(merged, caps.maxTextBytes)
  return buildCanonicalMessage(capped)
}

function degradePart(
  part: CanonicalPart,
  caps: MessageCapabilities
): CanonicalPart[] {
  switch (part.type) {
    case "text":
      return [part]
    case "mention":
      if (caps.supportsMention) return [part]
      return [{ type: "text", text: `@${part.displayName}` }]
    case "image":
      if (caps.supportsImage) return [part]
      return [
        {
          type: "system_marker",
          marker: "image_placeholder",
          original: { fileRef: part.fileRef },
        },
      ]
    case "voice":
      if (caps.supportsVoice) return [part]
      return [
        {
          type: "system_marker",
          marker: "voice_placeholder",
          label: part.transcript ? `[语音 ${part.transcript}]` : undefined,
          original: { fileRef: part.fileRef, durationMs: part.durationMs },
        },
      ]
    case "video":
      if (caps.supportsVideo) return [part]
      return [
        {
          type: "system_marker",
          marker: "video_placeholder",
          original: { fileRef: part.fileRef, durationMs: part.durationMs },
        },
      ]
    case "file":
      if (caps.supportsFile) return [part]
      return [
        {
          type: "text",
          text: part.fileRef.name ? `[文件 ${part.fileRef.name}]` : "[文件]",
        },
      ]
    case "card":
      if (caps.canSendCard) return [part]
      return [{ type: "text", text: part.fallbackText || "[卡片]" }]
    case "quote":
      if (caps.supportsReply) return [part]
      if (!part.quoted.preview) return []
      return [{ type: "text", text: `> ${part.quoted.preview}\n` }]
    case "reaction":
      if (caps.canReact) return [part]
      return [] // dropped silently
    case "interaction_prompt":
      if (caps.supportsInteractionPrompt) return [part]
      return [
        {
          type: "text",
          text: part.title
            ? `${part.title}\n${part.fallbackText}`
            : part.fallbackText,
        },
      ]
    case "system_marker":
      return [part]
  }
}

/**
 * Merge consecutive text parts into one. Mention flattening creates a lot of
 * adjacency, so this pass keeps the serialized form tidy.
 */
function mergeAdjacentText(parts: CanonicalPart[]): CanonicalPart[] {
  const merged: CanonicalPart[] = []
  for (const part of parts) {
    const prev = merged[merged.length - 1]
    if (part.type === "text" && prev?.type === "text") {
      merged[merged.length - 1] = {
        type: "text",
        text: prev.text + part.text,
      }
    } else {
      merged.push(part)
    }
  }
  return merged
}

/**
 * Truncate text parts whose UTF-8 byte length exceeds `maxBytes`.
 * Truncates on byte boundaries (avoiding multi-byte char split) and appends "…".
 * Non-text parts are left alone.
 */
function capTextParts(
  parts: CanonicalPart[],
  maxBytes: number
): CanonicalPart[] {
  if (maxBytes <= 0) return parts
  return parts.map((part) => {
    if (part.type !== "text") return part
    const truncated = truncateToBytes(part.text, maxBytes)
    if (truncated === part.text) return part
    return { type: "text", text: truncated }
  })
}

/**
 * Truncate string to at most `maxBytes` UTF-8 bytes (subtracting ellipsis).
 * Will not split a multi-byte character.
 */
export function truncateToBytes(s: string, maxBytes: number): string {
  const enc = new TextEncoder()
  const buf = enc.encode(s)
  if (buf.length <= maxBytes) return s
  const ellipsis = "…"
  const ellipsisBytes = enc.encode(ellipsis).length
  const budget = Math.max(0, maxBytes - ellipsisBytes)
  let cut = budget
  // Walk back until we land on a valid UTF-8 boundary
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) {
    cut -= 1
  }
  const dec = new TextDecoder()
  return dec.decode(buf.subarray(0, cut)) + ellipsis
}
