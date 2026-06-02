import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createLocalSandboxBackend,
  SandboxBackendError,
  type SandboxSpec,
} from "./sandbox-backend.js"
import type { HostProvider, PairResult, RunHandle } from "./host-provider.js"

function makeSpec(over: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    sessionId: "sess-123",
    workspaceId: "ws-1",
    sandboxRoot: "/tmp/sbx/sess-123",
    fsHelperPath: "/usr/local/bin/synapse-device-fs-helper",
    serverOrigin: "http://localhost:3001",
    confineCommands: true,
    title: "Sandbox sess-123",
    ...over,
  }
}

function stubProvider(over: Partial<HostProvider> = {}): HostProvider {
  return {
    async pair(): Promise<PairResult> {
      return { deviceId: "dev-1", serviceId: "svc-1" }
    },
    async run(): Promise<RunHandle> {
      return { pid: 999999, stop: async () => {} }
    },
    ...over,
  }
}

function beginPairing() {
  return async () => ({
    pairingCode: "code-1",
    brokerDir: "/tmp/sbx/sess-123/broker",
    pairingSessionId: "pair-1",
  })
}

test("local backend create(): fires staged callbacks in order and builds handle", async () => {
  const calls: string[] = []
  const backend = createLocalSandboxBackend({
    hostProvider: stubProvider(),
    beginLocalPairing: beginPairing(),
  })
  const handle = await backend.create(
    makeSpec({
      onPairingCreated: async (id) => {
        calls.push(`pairing:${id}`)
      },
      onDeviceClaimed: async (id) => {
        calls.push(`device:${id}`)
      },
      onResourceCreated: async (id) => {
        calls.push(`resource:${id}`)
      },
    })
  )
  // pairing is persisted before the device is claimed (crash-recovery ordering).
  assert.deepEqual(calls, ["pairing:pair-1", "device:dev-1"])
  assert.equal(handle.backend, "local")
  assert.equal(handle.sandboxId, "sess-123") // == sessionId
  assert.equal(handle.deviceId, "dev-1")
  assert.equal(handle.deviceServiceId, "svc-1")
  assert.equal(handle.pairingSessionId, "pair-1")
  assert.equal(handle.hostPid, 999999)
  assert.equal(handle.sandboxResourceId, "") // local has no provider resource id
})

test("local backend: pair failure propagates (run never called)", async () => {
  let ran = false
  const backend = createLocalSandboxBackend({
    hostProvider: stubProvider({
      async pair(): Promise<PairResult> {
        throw new Error("pair boom")
      },
      async run(): Promise<RunHandle> {
        ran = true
        return { pid: 1, stop: async () => {} }
      },
    }),
    beginLocalPairing: beginPairing(),
  })
  await assert.rejects(() => backend.create(makeSpec()), /pair boom/)
  assert.equal(ran, false, "run must not be called after pair fails")
})

test("local backend: run failure propagates after device claimed", async () => {
  const claimed: string[] = []
  const backend = createLocalSandboxBackend({
    hostProvider: stubProvider({
      async run(): Promise<RunHandle> {
        throw new Error("run boom")
      },
    }),
    beginLocalPairing: beginPairing(),
  })
  await assert.rejects(
    () =>
      backend.create(
        makeSpec({
          onDeviceClaimed: async (id) => {
            claimed.push(id)
          },
        })
      ),
    /run boom/
  )
  // The device WAS claimed+persisted before run failed — the spine's create()
  // cleanup deletes it; the staged callback must have fired so reconciler/cleanup
  // can find the device.
  assert.deepEqual(claimed, ["dev-1"])
})

test("local backend: a throwing staged callback aborts create()", async () => {
  const backend = createLocalSandboxBackend({
    hostProvider: stubProvider(),
    beginLocalPairing: beginPairing(),
  })
  await assert.rejects(
    () =>
      backend.create(
        makeSpec({
          onPairingCreated: async () => {
            throw new Error("persist boom")
          },
        })
      ),
    /persist boom/
  )
})

test("local handle: setTimeout throws unsupported (never a silent no-op)", async () => {
  const backend = createLocalSandboxBackend({
    hostProvider: stubProvider(),
    beginLocalPairing: beginPairing(),
  })
  const handle = await backend.create(makeSpec())
  await assert.rejects(
    () => handle.setTimeout(1000),
    SandboxBackendError,
    "setTimeout must throw, not silently no-op"
  )
})

test("local handle: getHost throws (no user-port routing in v1)", async () => {
  const backend = createLocalSandboxBackend({
    hostProvider: stubProvider(),
    beginLocalPairing: beginPairing(),
  })
  const handle = await backend.create(makeSpec())
  assert.throws(() => handle.getHost(3000), SandboxBackendError)
})

test("local handle: kill() delegates to the RunHandle.stop", async () => {
  let stopped = false
  const backend = createLocalSandboxBackend({
    hostProvider: stubProvider({
      async run(): Promise<RunHandle> {
        return {
          pid: 999999,
          stop: async () => {
            stopped = true
          },
        }
      },
    }),
    beginLocalPairing: beginPairing(),
  })
  const handle = await backend.create(makeSpec())
  await handle.kill()
  assert.equal(stopped, true)
})

test("local backend connect(): rejects a non-local ref", async () => {
  const backend = createLocalSandboxBackend({
    hostProvider: stubProvider(),
    beginLocalPairing: beginPairing(),
  })
  await assert.rejects(
    () =>
      backend.connect({
        backend: "docker",
        sandboxId: "sess-1",
        sandboxResourceId: "container-abc",
        deviceId: "dev-1",
      }),
    SandboxBackendError
  )
})

test("local backend connect(): rebuilds a kill-capable handle from a ref", async () => {
  const backend = createLocalSandboxBackend({
    hostProvider: stubProvider(),
    beginLocalPairing: beginPairing(),
  })
  const handle = await backend.connect({
    backend: "local",
    sandboxId: "sess-9",
    sandboxResourceId: "",
    deviceId: "dev-9",
    deviceServiceId: "svc-9",
    hostPid: undefined,
  })
  assert.equal(handle.sandboxId, "sess-9")
  assert.equal(handle.deviceId, "dev-9")
  // No hostPid → isRunning false, kill is a safe no-op.
  assert.equal(await handle.isRunning(), false)
  await handle.kill() // must not throw
})
