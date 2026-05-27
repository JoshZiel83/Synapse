import test from "node:test"
import assert from "node:assert/strict"

import {
  BrowserGrantPolicyError,
  normalizeBrowserGrantPolicy,
} from "./browser-grant-validator.js"
import type { BrowserPolicy } from "./browser.js"

function shouldThrow(
  policy: BrowserPolicy,
  field: string,
  hint?: RegExp
): void {
  try {
    normalizeBrowserGrantPolicy(policy)
    assert.fail(`expected BrowserGrantPolicyError for field=${field}`)
  } catch (err) {
    assert.ok(
      err instanceof BrowserGrantPolicyError,
      `expected BrowserGrantPolicyError, got ${String(err)}`
    )
    assert.equal((err as BrowserGrantPolicyError).field, field)
    if (hint) assert.match((err as Error).message, hint)
  }
}

test("normalizeBrowserGrantPolicy — origin scope happy path returns canonical copy", () => {
  const r = normalizeBrowserGrantPolicy({
    action: "read",
    scopeType: "origin",
    origin: "https://example.com",
    operations: ["page.read", "page.read"], // dedup test
  })
  assert.equal(r.origin, "https://example.com")
  assert.deepEqual(r.operations, ["page.read"])
})

test("normalizeBrowserGrantPolicy — host scope lowercases + punycode normalizes", () => {
  const r = normalizeBrowserGrantPolicy({
    action: "read",
    scopeType: "host",
    host: "EXAMPLE.com",
    operations: ["page.read"],
  })
  assert.equal(r.host, "example.com")
})

test("normalizeBrowserGrantPolicy — domain scope validated via PSL", () => {
  const r = normalizeBrowserGrantPolicy({
    action: "read",
    scopeType: "domain",
    registrableDomain: "example.com",
    operations: ["page.read"],
  })
  assert.equal(r.registrableDomain, "example.com")
})

test("normalizeBrowserGrantPolicy — missing operations throws", () => {
  shouldThrow(
    {
      action: "read",
      scopeType: "origin",
      origin: "https://example.com",
    } as BrowserPolicy,
    "operations"
  )
})

test("normalizeBrowserGrantPolicy — empty operations[] throws", () => {
  shouldThrow(
    {
      action: "read",
      scopeType: "origin",
      origin: "https://example.com",
      operations: [],
    },
    "operations"
  )
})

test("normalizeBrowserGrantPolicy — missing scopeType throws", () => {
  shouldThrow(
    {
      action: "read",
      operations: ["page.read"],
    } as BrowserPolicy,
    "scopeType"
  )
})

test("normalizeBrowserGrantPolicy — file: scheme rejected", () => {
  shouldThrow(
    {
      action: "read",
      scopeType: "origin",
      origin: "file:///etc/passwd",
      operations: ["page.read"],
    },
    "origin",
    /scheme not allowed/
  )
})

test("normalizeBrowserGrantPolicy — data: scheme rejected", () => {
  shouldThrow(
    {
      action: "read",
      scopeType: "origin",
      origin: "data:text/html,hi",
      operations: ["page.read"],
    },
    "origin",
    /scheme not allowed/
  )
})

test("normalizeBrowserGrantPolicy — javascript: scheme rejected", () => {
  shouldThrow(
    {
      action: "read",
      scopeType: "origin",
      origin: "javascript:alert(1)",
      operations: ["page.read"],
    },
    "origin"
  )
})

test("normalizeBrowserGrantPolicy — origin must equal new URL().origin (no trailing path)", () => {
  shouldThrow(
    {
      action: "read",
      scopeType: "origin",
      origin: "https://example.com/some/path",
      operations: ["page.read"],
    },
    "origin",
    /not a valid URL|origin/
  )
})

test("normalizeBrowserGrantPolicy — host with slashes rejected", () => {
  shouldThrow(
    {
      action: "read",
      scopeType: "host",
      host: "example.com/path",
      operations: ["page.read"],
    },
    "host"
  )
})

test("normalizeBrowserGrantPolicy — registrableDomain bare TLD rejected", () => {
  shouldThrow(
    {
      action: "read",
      scopeType: "domain",
      registrableDomain: "co.uk",
      operations: ["page.read"],
    },
    "registrableDomain",
    /PSL/
  )
})

test("normalizeBrowserGrantPolicy — scopeType=origin + extra host field rejected", () => {
  shouldThrow(
    {
      action: "read",
      scopeType: "origin",
      origin: "https://example.com",
      host: "example.com",
      operations: ["page.read"],
    },
    "scopeType"
  )
})

test("normalizeBrowserGrantPolicy — action=read + write-only operation rejected", () => {
  shouldThrow(
    {
      action: "read",
      scopeType: "origin",
      origin: "https://example.com",
      operations: ["page.read", "page.input"], // page.input is write-only
    },
    "action",
    /page\.input/
  )
})

test("normalizeBrowserGrantPolicy — action=write covers any operation mix", () => {
  const r = normalizeBrowserGrantPolicy({
    action: "write",
    scopeType: "origin",
    origin: "https://example.com",
    operations: ["page.read", "page.input", "page.navigate", "script.evaluate"],
  })
  assert.equal(r.action, "write")
  assert.equal(r.operations?.length, 4)
})

test("normalizeBrowserGrantPolicy — action=read + read-only operations passes", () => {
  const r = normalizeBrowserGrantPolicy({
    action: "read",
    scopeType: "origin",
    origin: "https://example.com",
    operations: ["page.read", "screenshot.capture", "console.read"],
  })
  assert.equal(r.action, "read")
})
