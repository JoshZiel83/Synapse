import test from "node:test"
import assert from "node:assert/strict"
import {
  parseListPagesResult,
  parseNavigationResult,
  parseSelectedPageUrl,
} from "./chrome-devtools-mcp.parsers.js"

test("parseListPagesResult — structured content array (future-proof path)", () => {
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

test("parseListPagesResult — 0.7.0 text format with ## Pages section", () => {
  const parsed = parseListPagesResult({
    content: [
      {
        type: "text",
        text: `# list_pages response

## Pages
0: https://example.com [selected]
1: https://other.com`,
      },
    ],
  })
  assert.equal(parsed.pages.length, 2)
  assert.equal(parsed.pages[0].pageId, 0)
  assert.equal(parsed.pages[0].url, "https://example.com")
  assert.equal(parsed.pages[0].isActive, true)
  assert.equal(parsed.pages[1].isActive, false)
})

test("parseListPagesResult — text with ## Pages and trailing ## Page content", () => {
  const parsed = parseListPagesResult({
    content: [
      {
        type: "text",
        text: `# navigate_page response

## Pages
0: https://example.com
1: https://allowed.com [selected]

## Page content
RootWebArea "x"`,
      },
    ],
  })
  assert.equal(parsed.pages.length, 2)
  assert.equal(parsed.pages.find((p) => p.isActive)?.url, "https://allowed.com")
})

test("parseListPagesResult — empty content returns empty list", () => {
  assert.deepEqual(parseListPagesResult({}).pages, [])
})

test("parseListPagesResult — text without Pages section returns empty", () => {
  const parsed = parseListPagesResult({
    content: [{ type: "text", text: "# something\nno pages here" }],
  })
  assert.deepEqual(parsed.pages, [])
})

test("parseNavigationResult — pulls resolvedUrl from selected page in text", () => {
  const r = parseNavigationResult({
    content: [
      {
        type: "text",
        text: `# navigate_page response
Navigation succeeded.

## Pages
0: https://example.com
1: https://blocked.com [selected]`,
      },
    ],
  })
  assert.equal(r.resolvedUrl, "https://blocked.com")
  assert.equal(r.pageId, 1)
})

test("parseNavigationResult — exposes full pages list for caller scope check", () => {
  const r = parseNavigationResult({
    content: [
      {
        type: "text",
        text: `# new_page response

## Pages
0: https://x.com
1: https://y.com [selected]
2: https://z.com`,
      },
    ],
  })
  assert.equal(r.pages.length, 3)
  assert.deepEqual(
    r.pages.map((p) => p.url),
    ["https://x.com", "https://y.com", "https://z.com"]
  )
})

test("parseNavigationResult — isError flips success", () => {
  const r = parseNavigationResult({
    isError: true,
    content: [{ type: "text", text: "nav failed" }],
  })
  assert.equal(r.success, false)
})

test("parseSelectedPageUrl — finds the selected page in text", () => {
  const url = parseSelectedPageUrl({
    content: [
      {
        type: "text",
        text: `## Pages
0: https://a [selected]
1: https://b`,
      },
    ],
  })
  assert.equal(url, "https://a")
})

test("parseSelectedPageUrl — returns null when no page is selected", () => {
  const url = parseSelectedPageUrl({
    content: [{ type: "text", text: "## Pages\n0: https://a" }],
  })
  assert.equal(url, null)
})
