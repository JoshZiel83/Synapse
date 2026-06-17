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
  type CanonicalFileRef,
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
      // Content-addressed, matching the chat layer's CanonicalFileRefBlock.
      sha256: string
      path?: string
      mimeType: string
      sizeBytes: number
      category: "image" | "video" | "audio" | "document" | "archive" | "other"
      name: string
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
 *   - a media part with no `sha256` is dropped from `contentBlocks` (a
 *     content-addressed file_ref requires it); it's still preserved in
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
      const f = part.fileRef
      if (!f.sha256) return null
      return {
        type: "file_ref",
        sha256: f.sha256,
        ...(f.path ? { path: f.path } : {}),
        mimeType: f.mimeType || "image/*",
        sizeBytes: f.sizeBytes || 0,
        category: "image",
        name: f.name || "image",
      }
    }
    case "voice": {
      const f = part.fileRef
      if (!f.sha256) return null
      return {
        type: "file_ref",
        sha256: f.sha256,
        ...(f.path ? { path: f.path } : {}),
        mimeType: f.mimeType || "audio/*",
        sizeBytes: f.sizeBytes || 0,
        category: "audio",
        name: f.name || "voice",
      }
    }
    case "video": {
      const f = part.fileRef
      if (!f.sha256) return null
      return {
        type: "file_ref",
        sha256: f.sha256,
        ...(f.path ? { path: f.path } : {}),
        mimeType: f.mimeType || "video/*",
        sizeBytes: f.sizeBytes || 0,
        category: "video",
        name: f.name || "video",
      }
    }
    case "file": {
      const f = part.fileRef
      if (!f.sha256) return null
      return {
        type: "file_ref",
        sha256: f.sha256,
        ...(f.path ? { path: f.path } : {}),
        mimeType: f.mimeType || "application/octet-stream",
        sizeBytes: f.sizeBytes || 0,
        category: classifyMime(f.mimeType),
        name: f.name,
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
    case "file_ref": {
      const fileRef: CanonicalFileRef = {
        sha256: block.sha256,
        ...(block.path ? { path: block.path } : {}),
        mimeType: block.mimeType,
        name: block.name,
        sizeBytes: block.sizeBytes,
      }
      if (block.category === "image") return { type: "image", fileRef }
      if (block.category === "audio") return { type: "voice", fileRef }
      if (block.category === "video") return { type: "video", fileRef }
      return {
        type: "file",
        fileRef: { ...fileRef, name: fileRef.name || "file" },
      }
    }
  }
}
