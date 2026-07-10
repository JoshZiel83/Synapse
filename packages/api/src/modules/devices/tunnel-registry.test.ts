// Unit test for the in-memory RuntimeEndpointRegistry. The frp-backed
// implementation in PR #6 will replace the singleton via
// setRuntimeEndpointRegistry; this contract test pins the interface.

import test from "node:test"
import assert from "node:assert/strict"
import {
  createInMemoryRuntimeEndpointRegistry,
  getRuntimeEndpointRegistry,
  setRuntimeEndpointRegistry,
} from "./tunnel-registry.js"

test("registry register / resolve / unregister round-trip", () => {
  const registry = createInMemoryRuntimeEndpointRegistry()
  assert.equal(registry.resolve("svc-1"), undefined)
  registry.register({
    runtimeServiceId: "svc-1",
    internalUrl: "http://tunnel-edge:7000/d/abc",
  })
  assert.deepEqual(registry.resolve("svc-1"), {
    runtimeServiceId: "svc-1",
    internalUrl: "http://tunnel-edge:7000/d/abc",
  })
  assert.deepEqual(registry.list(), [
    { runtimeServiceId: "svc-1", internalUrl: "http://tunnel-edge:7000/d/abc" },
  ])
  registry.unregister("svc-1")
  assert.equal(registry.resolve("svc-1"), undefined)
  assert.deepEqual(registry.list(), [])
})

test("registry re-register overwrites the prior endpoint", () => {
  const registry = createInMemoryRuntimeEndpointRegistry()
  registry.register({
    runtimeServiceId: "svc-1",
    internalUrl: "http://tunnel-edge:7000/d/old",
  })
  registry.register({
    runtimeServiceId: "svc-1",
    internalUrl: "http://tunnel-edge:7000/d/new",
  })
  assert.deepEqual(registry.resolve("svc-1"), {
    runtimeServiceId: "svc-1",
    internalUrl: "http://tunnel-edge:7000/d/new",
  })
})

test("compare-and-delete: a stale session's unregister cannot evict a live re-registered entry", () => {
  const registry = createInMemoryRuntimeEndpointRegistry()
  // Old socket (session A) registers, then a NEW socket (session B) reconnects and
  // re-registers the SAME service — overwriting the entry with B's sessionId.
  registry.register({
    runtimeServiceId: "svc-1",
    internalUrl: "http://tunnel-edge:7000/d/a",
    sessionId: "session-A",
  })
  registry.register({
    runtimeServiceId: "svc-1",
    internalUrl: "http://tunnel-edge:7000/d/b",
    sessionId: "session-B",
  })
  // The old socket's deferred close fires unregister with its OWN (stale) session.
  const removedStale = registry.unregister("svc-1", "session-A")
  assert.equal(removedStale, false)
  // The live entry (session B) MUST survive — this is the stale-close race fix.
  assert.deepEqual(registry.resolve("svc-1"), {
    runtimeServiceId: "svc-1",
    internalUrl: "http://tunnel-edge:7000/d/b",
    sessionId: "session-B",
  })
  // The owning session (B) can retire its own entry.
  const removedOwner = registry.unregister("svc-1", "session-B")
  assert.equal(removedOwner, true)
  assert.equal(registry.resolve("svc-1"), undefined)
})

test("forced unregister (no expected session) removes unconditionally", () => {
  const registry = createInMemoryRuntimeEndpointRegistry()
  registry.register({
    runtimeServiceId: "svc-1",
    internalUrl: "http://127.0.0.1:9000",
    sessionId: "session-X",
  })
  // Teardown path passes no expectedSessionId → unconditional removal.
  assert.equal(registry.unregister("svc-1"), true)
  assert.equal(registry.resolve("svc-1"), undefined)
})

test("singleton getter is stable and replaceable via setter", () => {
  const r1 = getRuntimeEndpointRegistry()
  const r2 = getRuntimeEndpointRegistry()
  assert.strictEqual(r1, r2)
  const fresh = createInMemoryRuntimeEndpointRegistry()
  setRuntimeEndpointRegistry(fresh)
  assert.strictEqual(getRuntimeEndpointRegistry(), fresh)
  setRuntimeEndpointRegistry(null)
  const r3 = getRuntimeEndpointRegistry()
  assert.notStrictEqual(r3, fresh)
})
