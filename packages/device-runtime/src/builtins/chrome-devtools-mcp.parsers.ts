// chrome-devtools-mcp result parsers. Sidecar emits MCP `content[]` blocks
// (typically text — the JSON-ish output the official server logs to stdout);
// when `--experimentalStructuredContent` is on, results also carry a
// `structuredContent` field with parseable objects. Parsers prefer structured
// content; text fallback covers MVP setups where the experimental flag is
// somehow disabled or differently named upstream.
//
// Plan §Phase 5, clarification #8 (parsers as their own testable module).

import type { McpCallToolResult } from "../mcp-stdio-sidecar.js"

export interface ChromePageSummary {
  pageId: number
  url: string
  title?: string
  isActive: boolean
}

export interface ParseListPagesResult {
  pages: ChromePageSummary[]
}

export interface ParseNavigationResult {
  resolvedUrl?: string
  pageId?: number
  success: boolean
}

/**
 * Parse a list_pages response. Prefers structured content (an array of
 * `{pageId,url,title,selected?}`) and falls back to scraping the canonical
 * text format. Returns an empty list rather than throwing — caller treats
 * "no pages" as a soft state.
 */
export function parseListPagesResult(
  result: McpCallToolResult
): ParseListPagesResult {
  const structured = result.structuredContent as unknown
  if (Array.isArray(structured)) {
    return { pages: structured.map(toPageSummary).filter(isPageSummary) }
  }
  if (
    structured &&
    typeof structured === "object" &&
    Array.isArray((structured as { pages?: unknown }).pages)
  ) {
    const arr = (structured as { pages: unknown[] }).pages
    return { pages: arr.map(toPageSummary).filter(isPageSummary) }
  }

  // Text fallback: chrome-devtools-mcp uses lines like
  //   "0: <selected> https://example.com — Example Domain"
  //   "1: https://other.com — Other"
  const text = collectText(result)
  if (!text) return { pages: [] }
  const pages: ChromePageSummary[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const match = line.match(
      /^(\d+)\s*:\s*(<selected>\s+)?(\S+)(?:\s+[—\-]\s+(.+))?$/
    )
    if (!match) continue
    pages.push({
      pageId: Number(match[1]),
      url: match[3],
      title: match[4]?.trim() || undefined,
      isActive: Boolean(match[2]),
    })
  }
  return { pages }
}

/** Parse `navigate_page` / `new_page` result. */
export function parseNavigationResult(
  result: McpCallToolResult
): ParseNavigationResult {
  const structured = result.structuredContent as
    | {
        resolvedUrl?: string
        url?: string
        pageId?: number
        success?: boolean
      }
    | undefined
  if (structured && typeof structured === "object") {
    return {
      resolvedUrl: structured.resolvedUrl ?? structured.url,
      pageId:
        typeof structured.pageId === "number" ? structured.pageId : undefined,
      success: structured.success !== false && !result.isError,
    }
  }
  const text = collectText(result)
  if (!text) {
    return { success: !result.isError }
  }
  const urlMatch = text.match(/https?:\/\/\S+/)
  const pageIdMatch = text.match(/page[_\s]?id[:=]?\s*(\d+)/i)
  return {
    resolvedUrl: urlMatch?.[0],
    pageId: pageIdMatch ? Number(pageIdMatch[1]) : undefined,
    success: !result.isError,
  }
}

/** Resolve the currently-selected page URL from a list_pages result. */
export function parseSelectedPageUrl(result: McpCallToolResult): string | null {
  const parsed = parseListPagesResult(result)
  const active = parsed.pages.find((p) => p.isActive)
  return active?.url ?? null
}

// ────────────────────────────── helpers ─────────────────────────────────────

function toPageSummary(value: unknown): ChromePageSummary | null {
  if (!value || typeof value !== "object") return null
  const obj = value as Record<string, unknown>
  const pageId =
    typeof obj.pageId === "number"
      ? obj.pageId
      : typeof obj.page_id === "number"
        ? obj.page_id
        : typeof obj.id === "number"
          ? obj.id
          : NaN
  const url =
    typeof obj.url === "string"
      ? obj.url
      : typeof obj.URL === "string"
        ? obj.URL
        : ""
  if (!Number.isFinite(pageId) || !url) return null
  const title =
    typeof obj.title === "string"
      ? obj.title
      : typeof obj.name === "string"
        ? obj.name
        : undefined
  const isActive =
    obj.isActive === true ||
    obj.selected === true ||
    obj.active === true ||
    obj.isSelected === true
  return { pageId, url, title, isActive }
}

function isPageSummary(
  value: ChromePageSummary | null
): value is ChromePageSummary {
  return value !== null
}

function collectText(result: McpCallToolResult): string {
  const out: string[] = []
  for (const block of result.content ?? []) {
    if (block && typeof block === "object") {
      const text = (block as { text?: unknown }).text
      if (typeof text === "string") out.push(text)
    }
  }
  return out.join("\n")
}
