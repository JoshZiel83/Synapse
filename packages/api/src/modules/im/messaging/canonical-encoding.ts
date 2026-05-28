/**
 * Bridge between CanonicalMessage (IM transport layer) and CanonicalContentBlock
 * (chat layer, persisted as `conversation_items` content_blocks JSONB).
 *
 * Direction:
 *   - When persisting an inbound transport message → encodeForConversationItem
 *     produces the {content, contentBlocks, transportMetadata} triple the chat
 *     service expects.
 *   - When projecting a conversation item outbound → decodeFromConversationItem
 *     reconstructs the CanonicalMessage from the persisted row.
 *
 * Compatibility:
 *   - `content` (plain string column) ← `plainText` (always). Frontends that
 *     only read `content` keep working unchanged.
 *   - Rich parts (card, quote, reaction, system_marker) have no
 *     CanonicalContentBlock counterpart; they live in
 *     `metadata.transport.canonicalParts` only.
 *   - On decode, prefer `metadata.transport.canonicalParts` (rich, lossless).
 *     Fall back to `contentBlocks` if not present. Fall back to `content`
 *     string if neither.
 */

import {
  buildCanonicalMessage,
  parseCanonicalMessage,
  type CanonicalMessage,
  type CanonicalPart,
} from "./canonical-message.js"

/**
 * Minimal subset of `CanonicalContentBlockInput` (shared/types) that we care
 * about here. We avoid importing from shared so that the messaging layer has
 * zero deps on shared's larger types graph.
 */
export type EncodedContentBlock =
  | { type: "text"; text: string }
  | {
      type: "file_ref"
      fileId: string
      url: string
      mimeType: string
      originalName: string
      sizeBytes: number
      category: "image" | "video" | "audio" | "document" | "archive" | "other"
    }
  | {
      type: "mention"
      mention: {
        participantId?: string
        participantType: string
        name?: string
        transportAddressId?: string
      }
    }

export interface EncodedTransportMetadata {
  canonicalParts: CanonicalPart[]
  schemaVersion: 1
}

export interface EncodedConversationItem {
  content: string
  contentBlocks: EncodedContentBlock[]
  transportMetadata: EncodedTransportMetadata
}

/**
 * Encode a CanonicalMessage into the row shape the chat service expects.
 *
 * Notes:
 *   - Rich parts that can't be represented as CanonicalContentBlock are
 *     dropped from `contentBlocks` but preserved in `transportMetadata`.
 *   - `mention` with neither externalId nor participantId becomes plain text
 *     (since it has nothing addressable).
 *   - `file` with no fileId is dropped from `contentBlocks` (the chat layer
 *     requires a file_id for file_ref blocks); it's still preserved in
 *     `transportMetadata`.
 */
export function encodeForConversationItem(
  msg: CanonicalMessage
): EncodedConversationItem {
  const contentBlocks: EncodedContentBlock[] = []
  for (const part of msg.parts) {
    const block = encodePart(part)
    if (block) contentBlocks.push(block)
  }
  return {
    content: msg.plainText,
    contentBlocks: collapseEmptyText(contentBlocks),
    transportMetadata: {
      canonicalParts: msg.parts,
      schemaVersion: 1,
    },
  }
}

function encodePart(part: CanonicalPart): EncodedContentBlock | null {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text }
    case "mention": {
      if (!part.participantId && !part.externalId) {
        // No addressable identity — fall back to text
        return { type: "text", text: `@${part.displayName || "unknown"}` }
      }
      return {
        type: "mention",
        mention: {
          participantId: part.participantId,
          participantType: part.participantId ? "external" : "external",
          name: part.displayName,
        },
      }
    }
    case "image": {
      const fileRef = part.fileRef
      if (!fileRef.fileId || !fileRef.url) return null
      return {
        type: "file_ref",
        fileId: fileRef.fileId,
        url: fileRef.url,
        mimeType: fileRef.mime || "image/*",
        originalName: fileRef.name || "image",
        sizeBytes: fileRef.sizeBytes || 0,
        category: "image",
      }
    }
    case "voice": {
      const fileRef = part.fileRef
      if (!fileRef.fileId || !fileRef.url) return null
      return {
        type: "file_ref",
        fileId: fileRef.fileId,
        url: fileRef.url,
        mimeType: fileRef.mime || "audio/*",
        originalName: fileRef.name || "voice",
        sizeBytes: fileRef.sizeBytes || 0,
        category: "audio",
      }
    }
    case "video": {
      const fileRef = part.fileRef
      if (!fileRef.fileId || !fileRef.url) return null
      return {
        type: "file_ref",
        fileId: fileRef.fileId,
        url: fileRef.url,
        mimeType: fileRef.mime || "video/*",
        originalName: fileRef.name || "video",
        sizeBytes: fileRef.sizeBytes || 0,
        category: "video",
      }
    }
    case "file": {
      const fileRef = part.fileRef
      if (!fileRef.fileId || !fileRef.url) return null
      return {
        type: "file_ref",
        fileId: fileRef.fileId,
        url: fileRef.url,
        mimeType: fileRef.mime || "application/octet-stream",
        originalName: fileRef.name,
        sizeBytes: fileRef.sizeBytes || 0,
        category: classifyMime(fileRef.mime),
      }
    }
    case "card":
    case "quote":
    case "reaction":
    case "interaction_prompt":
    case "system_marker":
      // Rich/control parts have no CanonicalContentBlock counterpart.
      // They're preserved in transportMetadata.canonicalParts only.
      return null
  }
}

function classifyMime(
  mime: string | undefined
): "image" | "video" | "audio" | "document" | "archive" | "other" {
  if (!mime) return "other"
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("video/")) return "video"
  if (mime.startsWith("audio/")) return "audio"
  if (
    mime === "application/pdf" ||
    mime === "application/msword" ||
    mime.startsWith("application/vnd.openxmlformats-officedocument") ||
    mime === "text/plain"
  ) {
    return "document"
  }
  if (mime === "application/zip" || mime === "application/x-tar") {
    return "archive"
  }
  return "other"
}

function collapseEmptyText(
  blocks: EncodedContentBlock[]
): EncodedContentBlock[] {
  return blocks.filter((b) => !(b.type === "text" && b.text === ""))
}

/**
 * Decode a CanonicalMessage from a persisted row. Tries in order:
 *   1) `metadata.transport.canonicalParts` (the lossless source)
 *   2) `contentBlocks` (re-derive from the lossy chat representation)
 *   3) `content` plaintext (single text part)
 */
export function decodeFromConversationItem(input: {
  content: string
  contentBlocks?: EncodedContentBlock[]
  transportMetadata?: unknown
}): CanonicalMessage {
  // Prefer rich source if present
  if (
    input.transportMetadata &&
    typeof input.transportMetadata === "object" &&
    !Array.isArray(input.transportMetadata)
  ) {
    const meta = input.transportMetadata as Record<string, unknown>
    if (Array.isArray(meta.canonicalParts)) {
      return parseCanonicalMessage({
        schemaVersion: 1,
        parts: meta.canonicalParts,
      })
    }
  }
  // Fall back to contentBlocks
  if (input.contentBlocks && input.contentBlocks.length > 0) {
    const parts: CanonicalPart[] = []
    for (const block of input.contentBlocks) {
      const part = decodeBlock(block)
      if (part) parts.push(part)
    }
    if (parts.length > 0) return buildCanonicalMessage(parts)
  }
  // Last resort: plaintext
  if (input.content) {
    return buildCanonicalMessage([{ type: "text", text: input.content }])
  }
  return buildCanonicalMessage([])
}

function decodeBlock(block: EncodedContentBlock): CanonicalPart | null {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text }
    case "mention":
      return {
        type: "mention",
        participantId: block.mention.participantId,
        displayName: block.mention.name || "",
      }
    case "file_ref":
      if (block.category === "image") {
        return {
          type: "image",
          fileRef: {
            fileId: block.fileId,
            url: block.url,
            mime: block.mimeType,
            name: block.originalName,
            sizeBytes: block.sizeBytes,
          },
        }
      }
      if (block.category === "audio") {
        return {
          type: "voice",
          fileRef: {
            fileId: block.fileId,
            url: block.url,
            mime: block.mimeType,
            name: block.originalName,
            sizeBytes: block.sizeBytes,
          },
        }
      }
      if (block.category === "video") {
        return {
          type: "video",
          fileRef: {
            fileId: block.fileId,
            url: block.url,
            mime: block.mimeType,
            name: block.originalName,
            sizeBytes: block.sizeBytes,
          },
        }
      }
      return {
        type: "file",
        fileRef: {
          fileId: block.fileId,
          url: block.url,
          mime: block.mimeType,
          name: block.originalName,
          sizeBytes: block.sizeBytes,
        },
      }
  }
}
