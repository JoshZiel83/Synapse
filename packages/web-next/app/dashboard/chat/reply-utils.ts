"use client"

import {
  extractText,
  type CanonicalContentBlock,
  type ConversationEntityRef,
  type ConversationReplyRef,
} from "@synapse/shared"

function summarizeFileCategories(blocks: CanonicalContentBlock[]) {
  const files = blocks.filter(
    (block): block is Extract<CanonicalContentBlock, { type: "file_ref" }> =>
      block.type === "file_ref"
  )

  if (files.length === 0) {
    return ""
  }

  if (files.length === 1) {
    const file = files[0]!
    switch (file.category) {
      case "image":
        return "Image"
      case "video":
        return "Video"
      case "audio":
        return "Audio"
      default:
        return file.originalName || "Attachment"
    }
  }

  return `${files.length} attachments`
}

export function buildContentBlocksPreviewText(blocks: CanonicalContentBlock[]) {
  const text = extractText(blocks).trim()
  if (text) {
    return text
  }

  return summarizeFileCategories(blocks)
}

export function buildReplyPreviewText(
  reply:
    | Pick<
        ConversationReplyRef,
        "previewText" | "previewBlocks" | "subtype" | "isUnavailable"
      >
    | null
    | undefined
) {
  if (!reply) {
    return ""
  }

  if (reply.isUnavailable) {
    return "Original message unavailable"
  }

  const previewText = reply.previewText.trim()
  if (previewText) {
    return previewText
  }

  const fallback = buildContentBlocksPreviewText(reply.previewBlocks)
  if (fallback) {
    return fallback
  }

  return reply.subtype ? `[${reply.subtype}]` : "Message"
}

export function getEntityDisplayName(
  entity: Pick<ConversationEntityRef, "name" | "participantType"> | undefined
) {
  const name = typeof entity?.name === "string" ? entity.name.trim() : ""
  if (name) {
    return name
  }

  switch (entity?.participantType) {
    case "actor":
      return "Actor"
    case "external":
      return "External"
    case "workspace_member":
      return "Member"
    default:
      return "System"
  }
}
