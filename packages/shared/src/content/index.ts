// Canonical content-block + tool-result runtime helpers.
//
// Migrated out of `types/index.ts` so that `@synapse/shared/types` stays a
// pure type surface (see docs/architecture-boundary-refactor-master-plan.md
// §2.2.1). These are re-exported from the package root barrel, so existing
// `@synapse/shared` imports keep working unchanged.

import type { UUID } from "../types/index.js"
import { isTransportKind } from "../constants/enums.js"
import type {
  CallableToolResult,
  CanonicalContentBlock,
  CanonicalContentBlockInput,
  CanonicalFileRefBlock,
  CanonicalMentionBlock,
  CanonicalTextBlock,
  CanonicalToolResult,
  ConversationEntityRef,
  ToolResultOrigin,
} from "../types/index.js"

export function createCanonicalContentBlockId(_prefix = "block"): UUID {
  // crypto.randomUUID is available in every runtime this ships to. The prefix
  // arg is retained for call-site readability but no longer affects the id (a
  // real UUID has no prefix); it previously only fed a Math.random fallback.
  return globalThis.crypto.randomUUID()
}

export function textBlock(text: string, id?: UUID): CanonicalTextBlock {
  return {
    id:
      typeof id === "string" && id.trim().length > 0
        ? id
        : createCanonicalContentBlockId("text"),
    type: "text",
    text,
  }
}

export function fileRefBlock(
  input: Omit<CanonicalFileRefBlock, "id" | "type"> & { id?: UUID }
): CanonicalFileRefBlock {
  return {
    id:
      typeof input.id === "string" && input.id.trim().length > 0
        ? input.id
        : createCanonicalContentBlockId("file"),
    type: "file_ref",
    sha256: input.sha256,
    ...(input.path !== undefined ? { path: input.path } : {}),
    mimeType: input.mimeType,
    name: input.name,
    sizeBytes: input.sizeBytes,
    category: input.category,
  }
}

export function mentionBlock(
  input: Omit<CanonicalMentionBlock, "id" | "type"> & { id?: UUID }
): CanonicalMentionBlock {
  return {
    id:
      typeof input.id === "string" && input.id.trim().length > 0
        ? input.id
        : createCanonicalContentBlockId("mention"),
    type: "mention",
    mention: input.mention,
  }
}

function normalizeContentBlockSizeBytes(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return null
}

function isConversationEntityRef(
  value: unknown
): value is ConversationEntityRef {
  if (!value || typeof value !== "object") return false
  const entity = value as Record<string, unknown>
  return (
    typeof entity.participantType === "string" &&
    entity.participantType.trim().length > 0 &&
    (entity.participantId === undefined ||
      typeof entity.participantId === "string") &&
    (entity.workspaceMemberId === undefined ||
      typeof entity.workspaceMemberId === "string") &&
    (entity.actorId === undefined || typeof entity.actorId === "string") &&
    (entity.userId === undefined || typeof entity.userId === "string") &&
    (entity.externalUserKey === undefined ||
      typeof entity.externalUserKey === "string") &&
    (entity.transportAddressId === undefined ||
      typeof entity.transportAddressId === "string") &&
    (entity.transportKind === undefined ||
      isTransportKind(entity.transportKind)) &&
    (entity.name === undefined || typeof entity.name === "string") &&
    (entity.title === undefined || typeof entity.title === "string") &&
    (entity.role === undefined || typeof entity.role === "string") &&
    (entity.avatarUrl === undefined || typeof entity.avatarUrl === "string") &&
    (entity.avatarEmoji === undefined || typeof entity.avatarEmoji === "string")
  )
}

export function formatMentionText(block: CanonicalMentionBlock): string {
  const name = block.mention.name?.trim() || "Unknown"
  return `@${name}`
}

export function isCanonicalContentBlock(
  value: unknown
): value is CanonicalContentBlock {
  if (!value || typeof value !== "object") return false

  const block = value as Record<string, unknown>
  if (typeof block.id !== "string" || block.id.trim().length === 0) return false

  if (block.type === "text") {
    return typeof block.text === "string"
  }

  if (block.type === "file_ref") {
    const sizeBytes = normalizeContentBlockSizeBytes(block.sizeBytes)
    return (
      // Redesigned FileRefBlock (file-service refactor): sha256 is the always-
      // present content identity; path is optional (present only for live
      // mounted spaces); name replaces originalName; fileId/url were dropped.
      // MUST mirror normalizeCanonicalContentBlocks' file_ref validation below,
      // else this guard (used as a strict filter in chat/event-registry.ts and
      // chat/message-content.ts) would reject every block fileRefBlock() emits.
      typeof block.sha256 === "string" &&
      (block.path === undefined || typeof block.path === "string") &&
      typeof block.mimeType === "string" &&
      typeof block.name === "string" &&
      sizeBytes !== null &&
      (block.category === "image" ||
        block.category === "audio" ||
        block.category === "video" ||
        block.category === "document")
    )
  }

  if (block.type === "mention") {
    return isConversationEntityRef(block.mention)
  }

  return false
}

export function normalizeCanonicalContentBlocks(
  blocks: CanonicalContentBlockInput[]
): CanonicalContentBlock[] {
  const normalized: CanonicalContentBlock[] = []

  for (const block of blocks || []) {
    if (!block || typeof block !== "object") continue

    if (block.type === "text") {
      if (typeof block.text !== "string") continue
      normalized.push(textBlock(block.text, block.id))
      continue
    }

    if (block.type === "file_ref") {
      const sizeBytes = normalizeContentBlockSizeBytes(block.sizeBytes)
      if (
        typeof block.sha256 !== "string" ||
        (block.path !== undefined && typeof block.path !== "string") ||
        typeof block.mimeType !== "string" ||
        typeof block.name !== "string" ||
        sizeBytes === null ||
        (block.category !== "image" &&
          block.category !== "audio" &&
          block.category !== "video" &&
          block.category !== "document")
      ) {
        continue
      }

      normalized.push(
        fileRefBlock({
          ...block,
          sizeBytes,
        })
      )
      continue
    }

    if (block.type === "mention") {
      if (!isConversationEntityRef(block.mention)) continue

      normalized.push(
        mentionBlock({
          id: block.id,
          mention: block.mention,
        })
      )
    }
  }

  return normalized
}

/** Wrap a plain string into CanonicalContentBlock[] */
export function textBlocks(s: string): CanonicalContentBlock[] {
  return [textBlock(s)]
}

/**
 * Convenience constructor for the common text-only CallableToolResult.
 * Equivalent to `{ content: textBlocks(text), ...opts }` but easier to read
 * in plugin handlers that return plain text plus an isError flag.
 */
export function textResult(
  text: string,
  opts?: {
    isError?: boolean
    structuredContent?: Record<string, unknown>
    metadata?: Record<string, unknown>
  }
): CallableToolResult {
  const result: CallableToolResult = { content: textBlocks(text) }
  if (opts?.isError !== undefined) result.isError = opts.isError
  if (opts?.structuredContent !== undefined)
    result.structuredContent = opts.structuredContent
  if (opts?.metadata !== undefined) result.metadata = opts.metadata
  return result
}

/**
 * Format a CanonicalToolResult.structuredContent payload as an XML-tagged
 * JSON suffix suitable for inclusion in provider tool_result content.
 *
 * Returns empty string when there is nothing to emit. Otherwise wraps the
 * JSON in `<structured_content>...</structured_content>` so the LLM has a
 * clear, parseable marker around the sidecar payload (distinct from the
 * primary text output). The XML tag matches the wrapping convention
 * context-compiler.ts uses for system_notice / event items.
 *
 * Callers append this to whatever string they're about to send to the
 * provider — Anthropic appends as a tool_result content text block,
 * OpenAI / OpenAI-Responses / BigModel append as a string suffix.
 */
export function formatStructuredContentForProvider(
  structuredContent: unknown
): string {
  if (!structuredContent || typeof structuredContent !== "object") return ""
  try {
    const json = JSON.stringify(structuredContent, null, 2)
    if (!json || json === "{}" || json === "null") return ""
    return `\n\n<structured_content>\n${json}\n</structured_content>`
  } catch {
    return ""
  }
}

/**
 * Type guard for ToolResultOrigin. Validates the discriminator and the
 * required fields per kind. Use at trust boundaries (e.g., when reading
 * a metadata column from the DB) before passing to downstream code that
 * relies on origin being correctly shaped.
 */
export function isToolResultOrigin(value: unknown): value is ToolResultOrigin {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  switch (v.kind) {
    case "system":
      return typeof v.registryKey === "string"
    case "plugin":
      return (
        typeof v.installationId === "string" &&
        typeof v.upstreamToolName === "string"
      )
    case "device":
      return (
        typeof v.deviceToolId === "string" &&
        typeof v.exposureStableKey === "string"
      )
    case "provider_native":
      return (
        typeof v.providerType === "string" && typeof v.toolName === "string"
      )
    case "model_response":
      return typeof v.providerType === "string"
    default:
      return false
  }
}

/**
 * Convenience constructor for CanonicalToolResult. Defaults isError=false
 * when not provided; leaves optional fields undefined when not provided
 * (do not store empty objects/arrays — keeps DB JSONB small).
 */
export function canonicalToolResult(input: {
  toolCallId: string
  providerCallId?: string
  toolName: string
  content: CanonicalContentBlock[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
  origin: ToolResultOrigin
  metadata?: Record<string, unknown>
}): CanonicalToolResult {
  const result: CanonicalToolResult = {
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    content: input.content,
    origin: input.origin,
  }
  if (input.providerCallId !== undefined)
    result.providerCallId = input.providerCallId
  if (input.structuredContent !== undefined)
    result.structuredContent = input.structuredContent
  if (input.isError !== undefined) result.isError = input.isError
  if (input.metadata !== undefined) result.metadata = input.metadata
  return result
}

/** Extract concatenated text from CanonicalContentBlock[] */
export function extractText(blocks: CanonicalContentBlock[]): string {
  let result = ""
  let previousKind: "text" | "mention" | null = null

  for (const block of blocks) {
    let chunk: string
    switch (block.type) {
      case "text":
        chunk = block.text
        break
      case "mention":
        chunk = formatMentionText(block)
        break
      default:
        chunk = ""
    }

    if (!chunk) continue

    if (!result) {
      result = chunk
      previousKind = block.type === "mention" ? "mention" : "text"
      continue
    }

    const nextKind = block.type === "mention" ? "mention" : "text"
    const separator =
      previousKind === "mention" ||
      nextKind === "mention" ||
      /\s$/.test(result) ||
      /^\s/.test(chunk)
        ? ""
        : "\n\n"

    result += `${separator}${chunk}`
    previousKind = nextKind
  }

  return result
}
