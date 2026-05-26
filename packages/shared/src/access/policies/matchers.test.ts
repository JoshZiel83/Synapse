// Lock the fail-closed semantics of browserPolicyAllows(neededOperations).
// Pairs with the shared/test-fixtures/runtime-auth/browser.json conformance
// suite (consumed by API tests); this file covers shape-level invariants
// where API import isn't worth the dependency.

import test from "node:test"
import assert from "node:assert/strict"

import { browserPolicyAllows, type BrowserPolicyShape } from "./matchers.js"
import { BrowserPolicySchema } from "./browser.js"
import { GrantPolicySchema } from "./grant.js"

const base: BrowserPolicyShape = {
  action: "write",
  scopeType: "origin",
  origin: "https://example.com",
}

test("browserPolicyAllows — neededOperations omitted ⇒ legacy path (scope+action only)", () => {
  assert.equal(
    browserPolicyAllows(base, {
      needed: "read",
      origin: "https://example.com",
    }),
    true
  )
})

test("browserPolicyAllows — neededOperations supplied but policy.operations missing ⇒ fail closed", () => {
  assert.equal(
    browserPolicyAllows(base, {
      needed: "read",
      origin: "https://example.com",
      neededOperations: ["page.read"],
    }),
    false
  )
})

test("browserPolicyAllows — neededOperations supplied + policy.operations subset ⇒ deny missing op", () => {
  const policy: BrowserPolicyShape = { ...base, operations: ["page.read"] }
  assert.equal(
    browserPolicyAllows(policy, {
      needed: "write",
      origin: "https://example.com",
      neededOperations: ["page.input"],
    }),
    false
  )
})

test("browserPolicyAllows — every needed op present ⇒ allow", () => {
  const policy: BrowserPolicyShape = {
    ...base,
    operations: ["page.read", "page.input"],
  }
  assert.equal(
    browserPolicyAllows(policy, {
      needed: "write",
      origin: "https://example.com",
      neededOperations: ["page.input"],
    }),
    true
  )
})

test("browserPolicyAllows — write covers read still holds with operations", () => {
  const policy: BrowserPolicyShape = { ...base, operations: ["page.read"] }
  assert.equal(
    browserPolicyAllows(policy, {
      needed: "read",
      origin: "https://example.com",
      neededOperations: ["page.read"],
    }),
    true
  )
})

test("BrowserPolicySchema.strip() drops unknown scopeSource on parse", () => {
  const parsed = BrowserPolicySchema.parse({
    action: "read",
    scopeType: "origin",
    origin: "https://example.com",
    operations: ["page.read"],
    scopeSource: "args", // unknown to schema
  } as Record<string, unknown>)
  assert.equal((parsed as Record<string, unknown>).scopeSource, undefined)
})

test("GrantPolicySchema.parse with browser block strips scopeSource (3rd line of defence)", () => {
  const parsed = GrantPolicySchema.parse({
    capability: "browser",
    browser: {
      action: "read",
      scopeType: "origin",
      origin: "https://example.com",
      operations: ["page.read"],
      scopeSource: "runtime_active_page",
    },
  } as Record<string, unknown>)
  const browser = parsed.browser as Record<string, unknown> | undefined
  assert.ok(browser)
  assert.equal(browser?.scopeSource, undefined)
})
