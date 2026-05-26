import test from "node:test"
import assert from "node:assert/strict"
import {
  parseListPagesResult,
  parseNavigationResult,
  parseSelectedPageUrl,
} from "./chrome-devtools-mcp.parsers.js"

test("parseListPagesResult — structured content array", () => {
  const parsed = parseListPagesResult({
    structuredContent: [
      { pageId: 0, url: "https://example.com", title: "A", selected: true },
      { pageId: 1, url: "https://other.com", title: "B" },
    ],
  })
  assert.equal(parsed.pages.length, 2)
  assert.equal(parsed.pages[0].url, "https://example.com")
  assert.equal(parsed.pages[0].isActive, true)
  assert.equal(parsed.pages[1].isActive, false)
})

test("parseListPagesResult — structured content {pages: []}", () => {
  const parsed = parseListPagesResult({
    structuredContent: {
      pages: [{ pageId: 7, url: "https://a.com", isActive: true }],
    },
  })
  assert.equal(parsed.pages[0].pageId, 7)
})

test("parseListPagesResult — text fallback canonical format", () => {
  const parsed = parseListPagesResult({
    content: [
      {
        type: "text",
        text: "0: <selected> https://example.com — Example Domain\n1: https://other.com — Other",
      },
    ],
  })
  assert.equal(parsed.pages.length, 2)
  assert.equal(parsed.pages[0].isActive, true)
  assert.equal(parsed.pages[1].url, "https://other.com")
})

test("parseListPagesResult — empty content returns empty list", () => {
  assert.deepEqual(parseListPagesResult({}).pages, [])
})

test("parseNavigationResult — structured success", () => {
  const r = parseNavigationResult({
    structuredContent: {
      resolvedUrl: "https://example.com/dashboard",
      pageId: 2,
      success: true,
    },
  })
  assert.equal(r.resolvedUrl, "https://example.com/dashboard")
  assert.equal(r.pageId, 2)
  assert.equal(r.success, true)
})

test("parseNavigationResult — text fallback extracts URL", () => {
  const r = parseNavigationResult({
    content: [{ type: "text", text: "navigated to https://example.com/x?y=1" }],
  })
  assert.equal(r.resolvedUrl, "https://example.com/x?y=1")
})

test("parseNavigationResult — isError flips success", () => {
  const r = parseNavigationResult({
    isError: true,
    content: [{ type: "text", text: "nav failed" }],
  })
  assert.equal(r.success, false)
})

test("parseSelectedPageUrl — finds the selected page", () => {
  const url = parseSelectedPageUrl({
    structuredContent: [
      { pageId: 0, url: "https://a", isActive: false },
      { pageId: 1, url: "https://b", isActive: true },
    ],
  })
  assert.equal(url, "https://b")
})

test("parseSelectedPageUrl — returns null when no page is selected", () => {
  const url = parseSelectedPageUrl({
    structuredContent: [{ pageId: 0, url: "https://a", isActive: false }],
  })
  assert.equal(url, null)
})
