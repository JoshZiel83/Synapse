import test from "node:test"
import assert from "node:assert/strict"
import { z } from "zod"
import { validateAndNormalizeAccountConfig } from "./account-config.js"

// Regression for the "generic /im/accounts route can write a QQ account
// with wildcard / IP domains because the per-transport normalizer only
// runs in the QQ-specific controller" issue. The fix sinks
// normalization into the service layer so EVERY write path enforces
// the rules. These tests guard that contract.

test("QQ: normalizes lowercase + strips scheme/port for hostnames", () => {
  const out = validateAndNormalizeAccountConfig({
    transportKind: "qq",
    config: {
      configuredUrlDomains: [
        "https://Dashboard.Example.com/path?q=1",
        "links.example.com:8443",
      ],
    },
  })
  assert.deepEqual(out.configuredUrlDomains, [
    "dashboard.example.com",
    "links.example.com",
  ])
})

test("QQ: rejects wildcard hostname via ZodError", () => {
  assert.throws(
    () =>
      validateAndNormalizeAccountConfig({
        transportKind: "qq",
        config: { configuredUrlDomains: ["*.evil.example.com"] },
      }),
    (err: unknown) => err instanceof z.ZodError
  )
})

test("QQ: rejects bare IPv4 literal", () => {
  assert.throws(
    () =>
      validateAndNormalizeAccountConfig({
        transportKind: "qq",
        config: { configuredUrlDomains: ["10.0.0.1"] },
      }),
    (err: unknown) => err instanceof z.ZodError
  )
})

test("QQ: defaults webhookInboundConfirmed + allowProactiveBestEffort to false on undefined", () => {
  const out = validateAndNormalizeAccountConfig({
    transportKind: "qq",
    config: {},
  })
  assert.equal(out.webhookInboundConfirmed, false)
  assert.equal(out.allowProactiveBestEffort, false)
  assert.deepEqual(out.configuredUrlDomains, [])
})

test('QQ: rejects string "true" for webhookInboundConfirmed (truthy-coercion guard)', () => {
  // Documented in qq-account-config.ts: NEVER do truthy checks on the
  // raw config; a stored `"false"` string would parse as truthy.
  assert.throws(
    () =>
      validateAndNormalizeAccountConfig({
        transportKind: "qq",
        config: { webhookInboundConfirmed: "true" },
      }),
    (err: unknown) => err instanceof z.ZodError
  )
})

test("QQ: undefined config defaults to {} (no throw)", () => {
  const out = validateAndNormalizeAccountConfig({
    transportKind: "qq",
    config: undefined,
  })
  assert.equal(out.webhookInboundConfirmed, false)
})

test("non-QQ transports: pass-through (no normalization, no rejection)", () => {
  // Feishu has no config schema today; whatever the operator sends
  // should land in the row untouched so future feishu-specific config
  // keys can land without a coordinated cross-cutting change.
  const out = validateAndNormalizeAccountConfig({
    transportKind: "feishu",
    config: { someUnknownKey: ["this", "stays"] },
  })
  assert.deepEqual(out, { someUnknownKey: ["this", "stays"] })
})
