import test from "node:test"
import assert from "node:assert/strict"
import {
  isDashboardDomainAllowed,
  normalizeQqAccountConfig,
  readQqAccountConfig,
} from "./qq-account-config.js"

test("normalize: defaults when absent", () => {
  const out = normalizeQqAccountConfig({})
  assert.equal(out.webhookInboundConfirmed, false)
  assert.equal(out.allowProactiveBestEffort, false)
  assert.deepEqual(out.configuredUrlDomains, [])
})

test('normalize: rejects string "true"/"false" for boolean field (no truthy coercion)', () => {
  assert.throws(
    () => normalizeQqAccountConfig({ webhookInboundConfirmed: "true" }),
    /webhookInboundConfirmed/
  )
  assert.throws(
    () => normalizeQqAccountConfig({ webhookInboundConfirmed: "false" }),
    /webhookInboundConfirmed/
  )
  assert.throws(
    () => normalizeQqAccountConfig({ webhookInboundConfirmed: 1 }),
    /webhookInboundConfirmed/
  )
})

test("normalize: configuredUrlDomains lowercases + strips scheme/path/port + dedupes", () => {
  const out = normalizeQqAccountConfig({
    configuredUrlDomains: [
      "https://Dashboard.Synapse.example/auth?x=1",
      "dashboard.synapse.example", // duplicate after normalize
      "  CDN.synapse.example:8443/file/ ",
      "https://cdn.synapse.example", // duplicate after normalize
    ],
  })
  assert.deepEqual(out.configuredUrlDomains, [
    "dashboard.synapse.example",
    "cdn.synapse.example",
  ])
})

test("normalize: rejects wildcards / IPs / empty strings", () => {
  assert.throws(
    () => normalizeQqAccountConfig({ configuredUrlDomains: ["*.foo.com"] }),
    /hostname/
  )
  assert.throws(
    () => normalizeQqAccountConfig({ configuredUrlDomains: ["10.0.0.1"] }),
    /hostname/
  )
  // empty strings filtered out (not rejected)
  const out = normalizeQqAccountConfig({
    configuredUrlDomains: ["", "ok.example"],
  })
  assert.deepEqual(out.configuredUrlDomains, ["ok.example"])
})

test("normalize: passthrough preserves unknown keys (forward-compat)", () => {
  const out = normalizeQqAccountConfig({ futureFlag: 42 } as Record<
    string,
    unknown
  >)
  assert.equal((out as unknown as { futureFlag: number }).futureFlag, 42)
})

test("readQqAccountConfig: handles null/undefined config", () => {
  assert.equal(readQqAccountConfig({}).webhookInboundConfirmed, false)
  assert.equal(
    readQqAccountConfig({ config: null }).webhookInboundConfirmed,
    false
  )
})

test("isDashboardDomainAllowed: case-insensitive membership", () => {
  const cfg = normalizeQqAccountConfig({
    configuredUrlDomains: ["dashboard.synapse.example"],
  })
  assert.equal(isDashboardDomainAllowed(cfg, "Dashboard.Synapse.example"), true)
  assert.equal(isDashboardDomainAllowed(cfg, "other.example"), false)
})
