import test from "node:test"
import assert from "node:assert/strict"

import { resolveUrlScope } from "./url-scope.js"

test("resolveUrlScope — https URL returns full triple", () => {
  const r = resolveUrlScope("https://sub.example.com/path?q=1")
  assert.equal(r.origin, "https://sub.example.com")
  assert.equal(r.host, "sub.example.com")
  assert.equal(r.registrableDomain, "example.com")
})

test("resolveUrlScope — http URL with port preserves port in origin", () => {
  const r = resolveUrlScope("http://example.com:8080/")
  assert.equal(r.origin, "http://example.com:8080")
  assert.equal(r.host, "example.com")
  assert.equal(r.registrableDomain, "example.com")
})

test("resolveUrlScope — uppercase hostname is lowercased", () => {
  const r = resolveUrlScope("https://EXAMPLE.COM/")
  assert.equal(r.host, "example.com")
})

test("resolveUrlScope — empty / non-string input returns empty triple", () => {
  assert.deepEqual(resolveUrlScope(""), {})
  assert.deepEqual(resolveUrlScope(123), {})
  assert.deepEqual(resolveUrlScope(null), {})
})

test("resolveUrlScope — unparseable input returns empty triple", () => {
  assert.deepEqual(resolveUrlScope("not a url"), {})
})

test("resolveUrlScope — co.uk multi-level public suffix resolved via tldts", () => {
  const r = resolveUrlScope("https://shop.foo.co.uk/")
  assert.equal(r.registrableDomain, "foo.co.uk")
})
