/**
 * Pure helpers for building memory-recall query strings. Extracted into its
 * own file so that tests can import `buildMemoryRecallQuery` without
 * transitively pulling in the module-level Redis client (created by
 * memory/service.ts -> embedding-cache.ts -> infrastructure/redis), which
 * blocks process exit on environments without Redis.
 */

import type { CanonicalContextItem } from "@synapse/shared/types"
import { extractText } from "@synapse/shared"

export const MEMORY_RECALL_MAX_CONTEXT_SNIPPETS = 8
export const MEMORY_RECALL_SNIPPET_MAX_CHARS = 240
export const MEMORY_RECALL_QUERY_MAX_CHARS = 1_200

export function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

export function truncateText(value: string, maxChars: number) {
  const ellipsis = "..."
  if (maxChars <= 0) return ""
  if (maxChars <= ellipsis.length) return ellipsis.slice(0, maxChars)

  const codePoints = Array.from(value)
  if (codePoints.length <= maxChars) return value
  return (
    codePoints
      .slice(0, Math.max(0, maxChars - ellipsis.length))
      .join("")
      .trimEnd() + ellipsis
  )
}

export function buildMemoryRecallQuery(params: {
  actorName?: string
  conversationTitle?: string
  contextItems: CanonicalContextItem[]
}) {
  const snippets: string[] = []
  const textualItems = params.contextItems
    .filter((item) => item.kind !== "memory_recall")
    .map((item) => {
      const parts = "parts" in item ? item.parts : undefined
      return normalizeWhitespace(extractText(parts || []).trim())
    })
    .filter(Boolean)

  const latestSnippet = textualItems.at(-1)
  if (latestSnippet) {
    snippets.push(truncateText(latestSnippet, MEMORY_RECALL_SNIPPET_MAX_CHARS))
  }
  if (params.conversationTitle) {
    snippets.push(
      truncateText(
        normalizeWhitespace(`conversation:${params.conversationTitle}`),
        MEMORY_RECALL_SNIPPET_MAX_CHARS
      )
    )
  }
  if (params.actorName) {
    snippets.push(
      truncateText(
        normalizeWhitespace(`actor:${params.actorName}`),
        MEMORY_RECALL_SNIPPET_MAX_CHARS
      )
    )
  }

  for (const text of textualItems.slice(
    -MEMORY_RECALL_MAX_CONTEXT_SNIPPETS - 1,
    -1
  )) {
    snippets.push(truncateText(text, MEMORY_RECALL_SNIPPET_MAX_CHARS))
  }

  return truncateText(snippets.join("\n").trim(), MEMORY_RECALL_QUERY_MAX_CHARS)
}
