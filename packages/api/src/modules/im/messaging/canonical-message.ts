/**
 * CanonicalMessage: platform-neutral message representation.
 *
 * Used as the boundary type between transport connectors and the IM ingest/delivery layers.
 * Each connector parses inbound payloads into CanonicalMessage and renders outbound payloads
 * from CanonicalMessage. The chat layer persists `plainText` to `conversation_items.content`
 * and `parts` to `conversation_items.metadata.transport.canonicalParts` (JSONB).
 *
 * Adding a new connector should not require changes to this file.
 */

export type CanonicalMessageSchemaVersion = 1
export const CANONICAL_MESSAGE_SCHEMA_VERSION: CanonicalMessageSchemaVersion = 1

/**
 * Content-addressed handle for a media attachment. Unified with the chat
 * layer's `CanonicalFileRefBlock`: the connector reads bytes from our CAS by
 * `sha256` (outbound) and writes them there (inbound), so the bytes always
 * flow through our storage rather than via a transient URL. There is exactly
 * ONE fileRef shape across the IM module.
 */
export interface CanonicalFileRef {
  /** sha256 of the bytes in our content-addressed store. The unified handle. */
  sha256?: string
  /** Optional live handle (sandbox space path); connectors ignore it. */
  path?: string
  mimeType?: string
  name?: string
  sizeBytes?: number
  width?: number
  height?: number
}

// TODO(canonical-card): namespace when a second card-producing connector lands
export type CanonicalCardSchema = "feishu_interactive_v1"

export type CanonicalSystemMarker =
  | "image_placeholder"
  | "voice_placeholder"
  | "video_placeholder"
  | "file_placeholder"
  | "card_placeholder"
  | "unknown_placeholder"

export type CanonicalPart =
  | { type: "text"; text: string }
  | {
      type: "mention"
      externalId?: string
      participantId?: string
      displayName: string
    }
  | { type: "image"; fileRef: CanonicalFileRef }
  | {
      type: "voice"
      fileRef: CanonicalFileRef
      durationMs?: number
      transcript?: string
    }
  | {
      type: "video"
      fileRef: CanonicalFileRef
      durationMs?: number
      width?: number
      height?: number
    }
  | { type: "file"; fileRef: CanonicalFileRef & { name: string } }
  | {
      type: "card"
      schema: CanonicalCardSchema
      payload: Record<string, unknown>
      fallbackText: string
    }
  | {
      type: "quote"
      quoted: { externalMessageId?: string; preview: string }
    }
  | {
      type: "reaction"
      emoji: string
      target: { externalMessageId: string }
    }
  | {
      /**
       * Server-side projection of a `tool_call_tasks` row into a
       * conversation. Carries the task id + a set of action
       * tokens that the receiving connector renders as a native control
       * (e.g. QQ Inline Keyboard buttons). The token is opaque to the
       * connector and is redeemed at click time via
       * `redeemActionToken(...)` to recover the full
       * ResolveTaskRequestParams payload.
       *
       * `fallbackText` is mandatory and rendered verbatim by connectors
       * that don't support `supportsInteractionPrompt`.
       */
      type: "interaction_prompt"
      taskId: string
      title?: string
      fallbackText: string
      options: Array<{
        id: string
        label: string
        actionToken: string
        style?: "primary" | "danger" | "default"
      }>
    }
  | {
      type: "system_marker"
      marker: CanonicalSystemMarker
      label?: string
      original?: Record<string, unknown>
    }

export interface CanonicalMessage {
  schemaVersion: CanonicalMessageSchemaVersion
  parts: CanonicalPart[]
  /**
   * Derived plaintext suitable for the legacy `conversation_items.content` column,
   * for search, and as a fallback for capability-limited transports.
   */
  plainText: string
}

const SYSTEM_MARKER_LABELS: Record<CanonicalSystemMarker, string> = {
  image_placeholder: "[图片]",
  voice_placeholder: "[语音]",
  video_placeholder: "[视频]",
  file_placeholder: "[文件]",
  card_placeholder: "[卡片]",
  unknown_placeholder: "[消息]",
}

/**
 * Build a CanonicalMessage from parts, computing plainText automatically.
 * Use this rather than constructing literals directly so plainText stays in sync.
 */
export function buildCanonicalMessage(
  parts: CanonicalPart[]
): CanonicalMessage {
  return {
    schemaVersion: CANONICAL_MESSAGE_SCHEMA_VERSION,
    parts: parts.slice(),
    plainText: derivePlainText(parts),
  }
}

/**
 * Convenience constructor for a single text part.
 */
export function textOnlyMessage(text: string): CanonicalMessage {
  return buildCanonicalMessage([{ type: "text", text }])
}

/**
 * Derive plaintext from parts. Each part contributes a textual representation;
 * adjacent fragments are joined with a single space. Empty fragments are dropped.
 *
 * Pure function. Whitespace is collapsed on the boundary between parts but
 * preserved within a single text part.
 */
export function derivePlainText(parts: CanonicalPart[]): string {
  const out: string[] = []
  for (const part of parts) {
    const fragment = renderPartAsPlainText(part)
    if (fragment) {
      out.push(fragment)
    }
  }
  return out.join(" ").trim()
}

function renderPartAsPlainText(part: CanonicalPart): string {
  switch (part.type) {
    case "text":
      return part.text
    case "mention":
      return `@${part.displayName}`
    case "image":
      return SYSTEM_MARKER_LABELS.image_placeholder
    case "voice":
      return part.transcript
        ? `[语音 ${part.transcript}]`
        : SYSTEM_MARKER_LABELS.voice_placeholder
    case "video":
      return SYSTEM_MARKER_LABELS.video_placeholder
    case "file":
      return part.fileRef.name
        ? `[文件 ${part.fileRef.name}]`
        : SYSTEM_MARKER_LABELS.file_placeholder
    case "card":
      return part.fallbackText || SYSTEM_MARKER_LABELS.card_placeholder
    case "quote":
      return part.quoted.preview ? `> ${part.quoted.preview}` : ""
    case "reaction":
      return part.emoji
    case "interaction_prompt":
      return part.title
        ? `${part.title}\n${part.fallbackText}`
        : part.fallbackText
    case "system_marker":
      return part.label || SYSTEM_MARKER_LABELS[part.marker]
  }
}

/**
 * Stable serialization of CanonicalMessage suitable for JSONB columns.
 * Returns a plain object that is JSON-roundtrip-safe.
 */
export function serializeCanonicalMessage(message: CanonicalMessage): {
  schemaVersion: CanonicalMessageSchemaVersion
  parts: CanonicalPart[]
  plainText: string
} {
  return {
    schemaVersion: message.schemaVersion,
    parts: message.parts.map(clonePart),
    plainText: message.plainText,
  }
}

function clonePart(part: CanonicalPart): CanonicalPart {
  return structuredClone(part)
}

/**
 * Parse a serialized CanonicalMessage from JSONB or other untrusted input.
 * Unknown part types are converted to a `system_marker` of kind `unknown_placeholder`,
 * preserving the original payload in `original` for debugging.
 * Missing or wrong-shaped input yields an empty message.
 */
export function parseCanonicalMessage(input: unknown): CanonicalMessage {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return buildCanonicalMessage([])
  }
  const raw = input as Record<string, unknown>
  const partsRaw = Array.isArray(raw.parts) ? raw.parts : []
  const parts: CanonicalPart[] = []
  for (const candidate of partsRaw) {
    const part = parsePart(candidate)
    if (part) {
      parts.push(part)
    }
  }
  return buildCanonicalMessage(parts)
}

function parsePart(input: unknown): CanonicalPart | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null
  }
  const raw = input as Record<string, unknown>
  const type = typeof raw.type === "string" ? raw.type : ""
  switch (type) {
    case "text": {
      const text = typeof raw.text === "string" ? raw.text : ""
      return { type: "text", text }
    }
    case "mention": {
      const mention: CanonicalPart & { type: "mention" } = {
        type: "mention",
        displayName: typeof raw.displayName === "string" ? raw.displayName : "",
      }
      if (typeof raw.externalId === "string") {
        mention.externalId = raw.externalId
      }
      if (typeof raw.participantId === "string") {
        mention.participantId = raw.participantId
      }
      return mention
    }
    case "image":
      return { type: "image", fileRef: parseFileRef(raw.fileRef) }
    case "voice": {
      const part: CanonicalPart & { type: "voice" } = {
        type: "voice",
        fileRef: parseFileRef(raw.fileRef),
      }
      if (typeof raw.durationMs === "number") {
        part.durationMs = raw.durationMs
      }
      if (typeof raw.transcript === "string") {
        part.transcript = raw.transcript
      }
      return part
    }
    case "video": {
      const part: CanonicalPart & { type: "video" } = {
        type: "video",
        fileRef: parseFileRef(raw.fileRef),
      }
      if (typeof raw.durationMs === "number") {
        part.durationMs = raw.durationMs
      }
      if (typeof raw.width === "number") {
        part.width = raw.width
      }
      if (typeof raw.height === "number") {
        part.height = raw.height
      }
      return part
    }
    case "file": {
      const fileRef = parseFileRef(raw.fileRef)
      return {
        type: "file",
        fileRef: { ...fileRef, name: fileRef.name || "file" },
      }
    }
    case "interaction_prompt": {
      const taskId =
        typeof raw.taskId === "string" && raw.taskId.trim() ? raw.taskId : ""
      if (!taskId) {
        // No anchor — degrade to system_marker so it survives roundtrip
        // but can never be acted on.
        return {
          type: "system_marker",
          marker: "unknown_placeholder",
          original: raw,
        }
      }
      const fallbackText =
        typeof raw.fallbackText === "string" && raw.fallbackText.trim()
          ? raw.fallbackText.trim().slice(0, 5000)
          : "需要审批，请回到 Synapse dashboard 处理"
      const optionsRaw = Array.isArray(raw.options) ? raw.options : []
      const options: Array<{
        id: string
        label: string
        actionToken: string
        style?: "primary" | "danger" | "default"
      }> = []
      for (const candidate of optionsRaw) {
        if (
          !candidate ||
          typeof candidate !== "object" ||
          Array.isArray(candidate)
        ) {
          continue
        }
        const c = candidate as Record<string, unknown>
        const id = typeof c.id === "string" ? c.id : ""
        const label = typeof c.label === "string" ? c.label : ""
        const actionToken =
          typeof c.actionToken === "string" ? c.actionToken : ""
        if (!id || !label || !actionToken) continue
        const style =
          c.style === "primary" || c.style === "danger" || c.style === "default"
            ? (c.style as "primary" | "danger" | "default")
            : undefined
        const option: {
          id: string
          label: string
          actionToken: string
          style?: "primary" | "danger" | "default"
        } = { id, label, actionToken }
        if (style) option.style = style
        options.push(option)
      }
      const part: CanonicalPart & { type: "interaction_prompt" } = {
        type: "interaction_prompt",
        taskId,
        fallbackText,
        options,
      }
      if (typeof raw.title === "string" && raw.title.trim()) {
        part.title = raw.title.trim().slice(0, 500)
      }
      return part
    }
    case "card": {
      const schema =
        raw.schema === "feishu_interactive_v1"
          ? raw.schema
          : "feishu_interactive_v1"
      const payload =
        raw.payload &&
        typeof raw.payload === "object" &&
        !Array.isArray(raw.payload)
          ? (raw.payload as Record<string, unknown>)
          : {}
      const fallbackText =
        typeof raw.fallbackText === "string" ? raw.fallbackText : ""
      return { type: "card", schema, payload, fallbackText }
    }
    case "quote": {
      const quotedRaw =
        raw.quoted &&
        typeof raw.quoted === "object" &&
        !Array.isArray(raw.quoted)
          ? (raw.quoted as Record<string, unknown>)
          : {}
      const quoted: { externalMessageId?: string; preview: string } = {
        preview: typeof quotedRaw.preview === "string" ? quotedRaw.preview : "",
      }
      if (typeof quotedRaw.externalMessageId === "string") {
        quoted.externalMessageId = quotedRaw.externalMessageId
      }
      return { type: "quote", quoted }
    }
    case "reaction": {
      const emoji = typeof raw.emoji === "string" ? raw.emoji : ""
      const targetRaw =
        raw.target &&
        typeof raw.target === "object" &&
        !Array.isArray(raw.target)
          ? (raw.target as Record<string, unknown>)
          : {}
      const externalMessageId =
        typeof targetRaw.externalMessageId === "string"
          ? targetRaw.externalMessageId
          : ""
      return {
        type: "reaction",
        emoji,
        target: { externalMessageId },
      }
    }
    case "system_marker": {
      const marker = isSystemMarker(raw.marker)
        ? raw.marker
        : "unknown_placeholder"
      const part: CanonicalPart & { type: "system_marker" } = {
        type: "system_marker",
        marker,
      }
      if (typeof raw.label === "string") {
        part.label = raw.label
      }
      if (
        raw.original &&
        typeof raw.original === "object" &&
        !Array.isArray(raw.original)
      ) {
        part.original = raw.original as Record<string, unknown>
      }
      return part
    }
    default:
      return {
        type: "system_marker",
        marker: "unknown_placeholder",
        original: raw,
      }
  }
}

function parseFileRef(input: unknown): CanonicalFileRef {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {}
  }
  const raw = input as Record<string, unknown>
  const out: CanonicalFileRef = {}
  if (typeof raw.sha256 === "string") out.sha256 = raw.sha256
  if (typeof raw.path === "string") out.path = raw.path
  if (typeof raw.mimeType === "string") out.mimeType = raw.mimeType
  if (typeof raw.name === "string") out.name = raw.name
  if (typeof raw.sizeBytes === "number") out.sizeBytes = raw.sizeBytes
  if (typeof raw.width === "number") out.width = raw.width
  if (typeof raw.height === "number") out.height = raw.height
  return out
}

function isSystemMarker(input: unknown): input is CanonicalSystemMarker {
  return (
    input === "image_placeholder" ||
    input === "voice_placeholder" ||
    input === "video_placeholder" ||
    input === "file_placeholder" ||
    input === "card_placeholder" ||
    input === "unknown_placeholder"
  )
}
