import test from "node:test"
import assert from "node:assert/strict"
import { slugify } from "./slug.js"

test("basic lowercasing + separator replacement", () => {
  assert.equal(slugify("Hello World"), "hello-world")
  assert.equal(slugify("  Trim  Me  "), "trim-me")
})

test("collapses repeats and trims edge separators", () => {
  assert.equal(slugify("a---b__c"), "a-b-c")
  assert.equal(slugify("--lead-and-trail--"), "lead-and-trail")
})

test("strips non-ascii (no transliteration) — matches old behavior", () => {
  // CJK collapses out, as the original hand-rolled versions did.
  assert.equal(slugify("你好 world"), "world")
  assert.equal(slugify("纯中文"), "")
})

test("fallback when empty", () => {
  assert.equal(slugify("纯中文", { fallback: "avatar" }), "avatar")
  assert.equal(slugify("", { fallback: "source" }), "source")
})

test("custom separator (dot)", () => {
  assert.equal(slugify("a b c", { separator: "." }), "a.b.c")
  assert.equal(slugify("x__y", { separator: "." }), "x.y")
})

test("maxLength caps and re-trims trailing separator", () => {
  assert.equal(slugify("abcdefghij", { maxLength: 5 }), "abcde")
  // cap landing on a separator should not leave a trailing one
  assert.equal(slugify("ab-cd-ef", { maxLength: 3 }), "ab")
})

test("equivalence with the legacy 120-cap dash slugifier", () => {
  const legacy = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120)
  for (const s of ["My Plugin!!", "weird___name", "  spaced  out  ", "a-b-c"]) {
    assert.equal(
      slugify(s, { maxLength: 120 }),
      legacy(s),
      `mismatch for "${s}"`
    )
  }
})
