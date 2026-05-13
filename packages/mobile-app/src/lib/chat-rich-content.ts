import type { Href } from "expo-router"

import { formatMentionText, type CanonicalContentBlock } from "@shared"

export type ChatPreviewCategory = "image" | "video" | "audio" | "document"
export type ChatPreviewSource = "local" | "remote"

export function serializeMarkdownBlocks(blocks: CanonicalContentBlock[]) {
  let result = ""
  let previousKind: "text" | "mention" | null = null

  for (const block of blocks) {
    const chunk =
      block.type === "text"
        ? block.text
        : block.type === "mention"
          ? formatMentionText(block)
          : ""

    if (!chunk) {
      continue
    }

    const nextKind = block.type === "mention" ? "mention" : "text"
    if (!result) {
      result = chunk
      previousKind = nextKind
      continue
    }

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

  return result.trim()
}

export function getAttachmentLabel(category: ChatPreviewCategory) {
  if (category === "image") return "图片"
  if (category === "video") return "视频"
  if (category === "audio") return "音频"
  return "文件"
}

export function isMarkdownMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase()
  return (
    normalized === "text/markdown" ||
    normalized === "text/x-markdown" ||
    normalized === "application/markdown"
  )
}

export function isTextPreviewMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase()
  return (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized === "application/ld+json" ||
    normalized === "application/xml" ||
    normalized === "text/xml" ||
    normalized === "application/javascript" ||
    normalized === "application/x-javascript" ||
    normalized === "text/javascript" ||
    normalized === "application/typescript" ||
    normalized === "text/csv" ||
    normalized === "application/x-yaml" ||
    normalized === "text/yaml" ||
    normalized === "application/yaml" ||
    isMarkdownMimeType(normalized)
  )
}

export function isPdfMimeType(mimeType: string) {
  return mimeType.toLowerCase() === "application/pdf"
}

export function sanitizeDownloadName(name: string) {
  const trimmed = name.trim()
  const fallback = trimmed || "download"
  return fallback.replace(/[\\/:*?"<>|]+/g, "_")
}

export function buildChatFilePreviewHref(input: {
  uri: string
  mimeType: string
  name: string
  category: ChatPreviewCategory
  source: ChatPreviewSource
}): Href {
  return {
    pathname: "/file-preview",
    params: {
      uri: input.uri,
      mimeType: input.mimeType,
      name: input.name,
      category: input.category,
      source: input.source,
    },
  }
}
