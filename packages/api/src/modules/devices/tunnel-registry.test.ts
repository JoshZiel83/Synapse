// Unit test for the in-memory DeviceTunnelRegistry. The frp-backed
// implementation in PR #6 will replace the singleton via
// setDeviceTunnelRegistry; this contract test pins the interface.

import test from "node:test"
import assert from "node:assert/strict"
import {
  createInMemoryDeviceTunnelRegistry,
  getDeviceTunnelRegistry,
  setDeviceTunnelRegistry,
} from "./tunnel-registry.js"

test("registry register / resolve / unregister round-trip", () => {
  const registry = createInMemoryDeviceTunnelRegistry()
  assert.equal(registry.resolve("svc-1"), undefined)
  registry.register({
    deviceServiceId: "svc-1",
    internalUrl: "http://tunnel-edge:7000/d/abc",
  })
  assert.deepEqual(registry.resolve("svc-1"), {
    deviceServiceId: "svc-1",
    internalUrl: "http://tunnel-edge:7000/d/abc",
  })
  assert.deepEqual(registry.list(), [
    { deviceServiceId: "svc-1", internalUrl: "http://tunnel-edge:7000/d/abc" },
  ])
  registry.unregister("svc-1")
  assert.equal(registry.resolve("svc-1"), undefined)
  assert.deepEqual(registry.list(), [])
})

test("registry re-register overwrites the prior endpoint", () => {
  const registry = createInMemoryDeviceTunnelRegistry()
  registry.register({
    deviceServiceId: "svc-1",
    internalUrl: "http://tunnel-edge:7000/d/old",
  })
  registry.register({
    deviceServiceId: "svc-1",
    internalUrl: "http://tunnel-edge:7000/d/new",
  })
  assert.deepEqual(registry.resolve("svc-1"), {
    deviceServiceId: "svc-1",
    internalUrl: "http://tunnel-edge:7000/d/new",
  })
})

test("singleton getter is stable and replaceable via setter", () => {
  const r1 = getDeviceTunnelRegistry()
  const r2 = getDeviceTunnelRegistry()
  assert.strictEqual(r1, r2)
  const fresh = createInMemoryDeviceTunnelRegistry()
  setDeviceTunnelRegistry(fresh)
  assert.strictEqual(getDeviceTunnelRegistry(), fresh)
  setDeviceTunnelRegistry(null)
  const r3 = getDeviceTunnelRegistry()
  assert.notStrictEqual(r3, fresh)
})
