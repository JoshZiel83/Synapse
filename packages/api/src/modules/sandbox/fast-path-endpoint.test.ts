// Service-level coverage for the fast-path tunnel-endpoint gate (R4 #1 / R5
// residual #1): when an existing sandbox is reused but the in-memory
// DeviceTunnelRegistry has no endpoint for it (e.g. after an API restart), the
// fast path must NOT reuse it — it waits, and on timeout returns false so the
// caller tears down + re-provisions. Driven through fastPathEndpointReady with a
// mix of the REAL registry/waiter and injected stubs.

import test from "node:test"
import assert from "node:assert/strict"
import {
  getDeviceTunnelRegistry,
  setDeviceTunnelRegistry,
  createInMemoryDeviceTunnelRegistry,
} from "../devices/tunnel-registry.js"
import { fastPathEndpointReady, waitForTunnelEndpoint } from "./service.js"

test("fastPathEndpointReady: no device_runtime service → not reusable", async () => {
  const ok = await fastPathEndpointReady(
    { sessionId: "s1", deviceId: "dev-1", tunnelTimeoutMs: 1000 },
    {
      resolveServiceId: async () => null,
      waitForEndpoint: async () => {
        throw new Error("should not be called")
      },
    }
  )
  assert.equal(ok, false)
})

test("fastPathEndpointReady: empty deviceId → not reusable (no resolve attempt)", async () => {
  let resolveCalled = false
  const ok = await fastPathEndpointReady(
    { sessionId: "s1", deviceId: "", tunnelTimeoutMs: 1000 },
    {
      resolveServiceId: async () => {
        resolveCalled = true
        return "svc-x"
      },
      waitForEndpoint: async () => {},
    }
  )
  assert.equal(ok, false)
  assert.equal(resolveCalled, false, "empty deviceId short-circuits")
})

test("fastPathEndpointReady: tunnelTimeoutMs<=0 skips the wait (test opt-out)", async () => {
  let waited = false
  const ok = await fastPathEndpointReady(
    { sessionId: "s1", deviceId: "dev-1", tunnelTimeoutMs: 0 },
    {
      resolveServiceId: async () => "svc-1",
      waitForEndpoint: async () => {
        waited = true
      },
    }
  )
  assert.equal(ok, true)
  assert.equal(waited, false, "no endpoint wait when timeout<=0")
})

test("fastPathEndpointReady: endpoint present → reusable", async () => {
  const ok = await fastPathEndpointReady(
    { sessionId: "s1", deviceId: "dev-1", tunnelTimeoutMs: 1000 },
    {
      resolveServiceId: async () => "svc-1",
      waitForEndpoint: async () => {
        /* resolves immediately = endpoint registered */
      },
    }
  )
  assert.equal(ok, true)
})

test("fastPathEndpointReady: endpoint never registers (timeout) → NOT reusable → reprovision", async () => {
  const ok = await fastPathEndpointReady(
    { sessionId: "s1", deviceId: "dev-1", tunnelTimeoutMs: 1000 },
    {
      resolveServiceId: async () => "svc-1",
      waitForEndpoint: async () => {
        throw new Error(
          "device_service svc-1 did not register a tunnel endpoint"
        )
      },
    }
  )
  assert.equal(
    ok,
    false,
    "timeout means the caller must teardown + reprovision"
  )
})

// Integration with the REAL registry + REAL waiter (only the DB-backed
// service-id resolver is stubbed): an empty registry makes fastPathEndpointReady
// time out → false; registering the endpoint flips a later call to true. This
// proves the production wiring (waitForTunnelEndpoint ↔ DeviceTunnelRegistry),
// not just the injected-stub branches above.
test("fastPathEndpointReady (real registry + waiter): empty → false; populated → true", async () => {
  const prev = getDeviceTunnelRegistry()
  const registry = createInMemoryDeviceTunnelRegistry()
  setDeviceTunnelRegistry(registry)
  try {
    const realDeps = {
      resolveServiceId: async () => "svc-real",
      waitForEndpoint: (serviceId: string, timeoutMs: number) =>
        waitForTunnelEndpoint(serviceId, { timeoutMs, pollMs: 50 }),
    }
    const timedOut = await fastPathEndpointReady(
      { sessionId: "s-real", deviceId: "dev-real", tunnelTimeoutMs: 400 },
      realDeps
    )
    assert.equal(timedOut, false, "empty registry → timeout → not reusable")

    registry.register({
      deviceServiceId: "svc-real",
      internalUrl: "http://127.0.0.1:9/d/x",
    })
    const nowOk = await fastPathEndpointReady(
      { sessionId: "s-real", deviceId: "dev-real", tunnelTimeoutMs: 400 },
      realDeps
    )
    assert.equal(nowOk, true, "endpoint registered → reusable")
  } finally {
    setDeviceTunnelRegistry(prev)
  }
})
