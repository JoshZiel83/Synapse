// Service-level coverage for the fast-path tunnel-endpoint gate (R4 #1 / R5
// residual #1): when an existing sandbox is reused but the in-memory
// RuntimeEndpointRegistry has no endpoint for it (e.g. after an API restart), the
// fast path must NOT reuse it — it waits, and on timeout returns false so the
// caller tears down + re-provisions. Driven through fastPathEndpointReady with a
// mix of the REAL registry/waiter and injected stubs.

import test from "node:test"
import assert from "node:assert/strict"
import {
  getRuntimeEndpointRegistry,
  setRuntimeEndpointRegistry,
  createInMemoryRuntimeEndpointRegistry,
} from "../devices/tunnel-registry.js"
import { fastPathEndpointReady, waitForTunnelEndpoint } from "./service.js"

test("fastPathEndpointReady: no device_runtime service → not reusable", async () => {
  const ok = await fastPathEndpointReady(
    {
      sessionId: "s1",
      runtimeId: "dev-1",
      mode: "resident",
      tunnelTimeoutMs: 1000,
    },
    {
      resolveServiceId: async () => null,
      waitForEndpoint: async () => {
        throw new Error("should not be called")
      },
    }
  )
  assert.equal(ok, false)
})

test("fastPathEndpointReady: empty runtimeId → not reusable (no resolve attempt)", async () => {
  let resolveCalled = false
  const ok = await fastPathEndpointReady(
    { sessionId: "s1", runtimeId: "", mode: "resident", tunnelTimeoutMs: 1000 },
    {
      resolveServiceId: async () => {
        resolveCalled = true
        return "svc-x"
      },
      waitForEndpoint: async () => {},
    }
  )
  assert.equal(ok, false)
  assert.equal(resolveCalled, false, "empty runtimeId short-circuits")
})

test("fastPathEndpointReady: tunnelTimeoutMs<=0 skips the wait (test opt-out)", async () => {
  let waited = false
  const ok = await fastPathEndpointReady(
    {
      sessionId: "s1",
      runtimeId: "dev-1",
      mode: "resident",
      tunnelTimeoutMs: 0,
    },
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
    {
      sessionId: "s1",
      runtimeId: "dev-1",
      mode: "resident",
      tunnelTimeoutMs: 1000,
    },
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
    {
      sessionId: "s1",
      runtimeId: "dev-1",
      mode: "resident",
      tunnelTimeoutMs: 1000,
    },
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

// P4: a BARE (Mode-B) runtime has no device_runtime service — the fast path must
// reuse it immediately WITHOUT resolving a device_runtime service (which it would
// never have → false every turn → needless teardown + reprovision). The
// resolveServiceId / waitForEndpoint stubs THROW to prove the bare branch never
// touches the device_runtime lookup.
test("fastPathEndpointReady: mode='bare' → reusable without any device_runtime lookup", async () => {
  const ok = await fastPathEndpointReady(
    {
      sessionId: "s1",
      runtimeId: "bare-1",
      mode: "bare",
      tunnelTimeoutMs: 1000,
    },
    {
      resolveServiceId: async () => {
        throw new Error(
          "bare fast path must NOT resolve a device_runtime service"
        )
      },
      waitForEndpoint: async () => {
        throw new Error("bare fast path must NOT wait for a tunnel endpoint")
      },
    }
  )
  assert.equal(ok, true, "bare runtime is reused directly")
})

// Integration with the REAL registry + REAL waiter (only the DB-backed
// service-id resolver is stubbed): an empty registry makes fastPathEndpointReady
// time out → false; registering the endpoint flips a later call to true. This
// proves the production wiring (waitForTunnelEndpoint ↔ RuntimeEndpointRegistry),
// not just the injected-stub branches above.
test("fastPathEndpointReady (real registry + waiter): empty → false; populated → true", async () => {
  const prev = getRuntimeEndpointRegistry()
  const registry = createInMemoryRuntimeEndpointRegistry()
  setRuntimeEndpointRegistry(registry)
  try {
    const realDeps = {
      resolveServiceId: async () => "svc-real",
      waitForEndpoint: (serviceId: string, timeoutMs: number) =>
        waitForTunnelEndpoint(serviceId, { timeoutMs, pollMs: 50 }),
    }
    const timedOut = await fastPathEndpointReady(
      {
        sessionId: "s-real",
        runtimeId: "dev-real",
        mode: "resident",
        tunnelTimeoutMs: 400,
      },
      realDeps
    )
    assert.equal(timedOut, false, "empty registry → timeout → not reusable")

    registry.register({
      runtimeServiceId: "svc-real",
      internalUrl: "http://127.0.0.1:9/d/x",
    })
    const nowOk = await fastPathEndpointReady(
      {
        sessionId: "s-real",
        runtimeId: "dev-real",
        mode: "resident",
        tunnelTimeoutMs: 400,
      },
      realDeps
    )
    assert.equal(nowOk, true, "endpoint registered → reusable")
  } finally {
    setRuntimeEndpointRegistry(prev)
  }
})
