// chrome-devtools-mcp result parsers. 0.7.0 sidecar emits text content blocks
// only — no structuredContent. Tool responses are formatted as:
//   # <tool-name> response
//   <optional response lines>
//   ## Pages
//   0: https://example.com [selected]
//   1: https://other.com
//   ## Page content
//   <a11y snapshot>
//   ...
// `setIncludePages(true)` is called by every navigation/page tool AND by
// list_pages, so both go through the same `## Pages` section extraction.
//
// Plan §Phase 5; reverified against
// node_modules/chrome-devtools-mcp/build/src/McpResponse.js after the
// 2026-05-27 drift report. structuredContent code paths kept for forward
// compatibility (newer upstreams may emit it) but the real path is text.

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
  /** All pages reported in the response — caller can compare against grants. */
  pages: ChromePageSummary[]
  success: boolean
}

/**
 * Parse a list_pages response. Prefers structured content (future-proofing);
 * the live 0.7.0 sidecar emits a `## Pages` text section, which we extract
 * with the regex below. Returns an empty list rather than throwing — caller
 * treats "no pages" as a soft state.
 */
export function parseListPagesResult(
  result: McpCallToolResult
): ParseListPagesResult {
  // 1) structured (forward compatibility)
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

  // 2) 0.7.0 text format
  return { pages: extractPagesSectionFromText(collectText(result)) }
}

/**
 * Parse `navigate_page` / `new_page` / `navigate_page_history` result.
 * 0.7.0 always includes the `## Pages` section after navigation (via
 * `setIncludePages(true)`), so we use the *selected* page URL as the
 * resolved URL — never the first URL found in arbitrary text.
 */
export function parseNavigationResult(
  result: McpCallToolResult
): ParseNavigationResult {
  // structured (future)
  const structured = result.structuredContent as
    | {
        resolvedUrl?: string
        url?: string
        pageId?: number
        success?: boolean
        pages?: unknown
      }
    | undefined
  if (structured && typeof structured === "object") {
    const fromStructured: ChromePageSummary[] = Array.isArray(structured.pages)
      ? structured.pages.map(toPageSummary).filter(isPageSummary)
      : []
    const active = fromStructured.find((p) => p.isActive)
    return {
      resolvedUrl: structured.resolvedUrl ?? structured.url ?? active?.url,
      pageId:
        typeof structured.pageId === "number"
          ? structured.pageId
          : (active?.pageId ?? undefined),
      pages: fromStructured,
      success: structured.success !== false && !result.isError,
    }
  }
  const pages = extractPagesSectionFromText(collectText(result))
  const active = pages.find((p) => p.isActive)
  return {
    resolvedUrl: active?.url,
    pageId: active?.pageId,
    pages,
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

/**
 * Extract `## Pages` section, then parse lines like
 *   `0: https://example.com [selected]`
 * `idx` matches `getPages()` order, `[selected]` flags the selected page.
 */
function extractPagesSectionFromText(text: string): ChromePageSummary[] {
  if (!text) return []
  const sectionMatch = text.match(/##\s*Pages\b([\s\S]*?)(?:\n##\s|$)/)
  if (!sectionMatch) return []
  const body = sectionMatch[1] ?? ""
  const out: ChromePageSummary[] = []
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    // `<idx>: <url>[ [selected]]`
    const m = line.match(/^(\d+)\s*:\s*(\S+?)(\s+\[selected\])?$/)
    if (!m) continue
    out.push({
      pageId: Number(m[1]),
      url: m[2],
      isActive: Boolean(m[3]),
    })
  }
  return out
}

function pickPageId(obj: Record<string, unknown>): number {
  if (typeof obj.pageId === "number") return obj.pageId
  if (typeof obj.page_id === "number") return obj.page_id
  if (typeof obj.pageIdx === "number") return obj.pageIdx
  if (typeof obj.id === "number") return obj.id
  return NaN
}

function pickUrl(obj: Record<string, unknown>): string {
  if (typeof obj.url === "string") return obj.url
  if (typeof obj.URL === "string") return obj.URL
  return ""
}

function pickTitle(obj: Record<string, unknown>): string | undefined {
  if (typeof obj.title === "string") return obj.title
  if (typeof obj.name === "string") return obj.name
  return undefined
}

function toPageSummary(value: unknown): ChromePageSummary | null {
  if (!value || typeof value !== "object") return null
  const obj = value as Record<string, unknown>
  const pageId = pickPageId(obj)
  const url = pickUrl(obj)
  if (!Number.isFinite(pageId) || !url) return null
  const title = pickTitle(obj)
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
