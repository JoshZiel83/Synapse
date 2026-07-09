import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createLocalSandboxBackend,
  SandboxBackendError,
  type SandboxSpec,
} from "./sandbox-backend.js"
import type { HostProvider, PairResult, RunHandle } from "./host-provider.js"
import type { mintLocalSandboxRuntime } from "../devices/service.js"

// Direct-mint (§4.6): the local backend authors a device-less sandbox-kind
// runtime + broker identity in-process (no pairing round-trip). These tests
// inject a mintRuntime seam (no DB) and use a real temp broker dir (the broker
// writes device-identity.json / device-keys.json there).

const roots: string[] = []
function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sbx-test-"))
  roots.push(root)
  return root
}
test.after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function makeSpec(over: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    sessionId: "sess-123",
    workspaceId: "ws-1",
    sandboxRoot: tmpRoot(),
    fsHelperPath: "/usr/local/bin/synapse-device-fs-helper",
    serverOrigin: "http://localhost:3001",
    confineCommands: true,
    title: "Sandbox sess-123",
    ...over,
  }
}

function stubProvider(over: Partial<HostProvider> = {}): HostProvider {
  return {
    blobAccess() {
      return { kind: "local_cas", casDir: "/tmp/cas" }
    },
    async pair(): Promise<PairResult> {
      return { deviceId: "dev-1", serviceId: "svc-1" }
    },
    async run(): Promise<RunHandle> {
      return { pid: 999999, stop: async () => {} }
    },
    ...over,
  }
}

type MintArgs = Parameters<typeof mintLocalSandboxRuntime>[0]

/** A mintRuntime spy that records its args and echoes the ids back. */
function spyMint(box: { args?: MintArgs }): typeof mintLocalSandboxRuntime {
  return async (a: MintArgs) => {
    box.args = a
    return {
      runtimeId: a.runtimeId,
      serviceId: a.serviceId,
      serviceKeyId: a.serviceKeyId,
    }
  }
}

test("local backend create(): mints a device-less runtime + fires onRuntimeReady + builds the runtimeLink handle", async () => {
  const box: { args?: MintArgs } = {}
  const calls: string[] = []
  const backend = createLocalSandboxBackend({
    hostProvider: stubProvider(),
    mintRuntime: spyMint(box),
  })
  const handle = await backend.create(
    makeSpec({
      onRuntimeReady: async (id) => {
        calls.push(`ready:${id}`)
      },
    })
  )
  assert.ok(box.args, "mintRuntime was called")
  // The handle's runtime link matches what was minted; onRuntimeReady got the
  // same runtime id (== sandboxes.id, NO devices row).
  assert.equal(handle.adapter, "local")
  assert.equal(handle.mode, "resident")
  assert.equal(handle.sandboxId, "sess-123") // == sessionId (registry key)
  assert.equal(handle.resourceId, "") // local has no provider resource id
  assert.equal(handle.hostPid, 999999)
  assert.equal(handle.runtimeLink.runtimeId, box.args!.runtimeId)
  assert.equal(handle.runtimeLink.runtimeServiceId, box.args!.serviceId)
  assert.deepEqual(calls, [`ready:${box.args!.runtimeId}`])
  // The minted runtime is bound to the session + workspace + local adapter.
  assert.equal(box.args!.sessionId, "sess-123")
  assert.equal(box.args!.workspaceId, "ws-1")
})

test("local backend: mint failure self-cleans (runtimeId null — nothing minted)", async () => {
  const cleaned: Array<{
    workspaceId: string
    runtimeId: string | null
    brokerDir: string
  }> = []
  let ran = false
  const backend = createLocalSandboxBackend({
    hostProvider: stubProvider({
      async run(): Promise<RunHandle> {
        ran = true
        return { pid: 1, stop: async () => {} }
      },
    }),
    mintRuntime: async () => {
      throw new Error("mint boom")
    },
    failCleanup: async (a) => {
      cleaned.push(a)
    },
  })
  await assert.rejects(() => backend.create(makeSpec()), /mint boom/)
  assert.equal(ran, false, "run must not be called after mint fails")
  assert.equal(cleaned.length, 1)
  assert.equal(cleaned[0]!.runtimeId, null, "nothing minted → runtimeId null")
  assert.equal(cleaned[0]!.workspaceId, "ws-1")
})

test("local backend: run failure self-cleans the minted runtime (no leak)", async () => {
  const box: { args?: MintArgs } = {}
  const cleaned: Array<{
    workspaceId: string
    runtimeId: string | null
    brokerDir: string
  }> = []
  const backend = createLocalSandboxBackend({
    hostProvider: stubProvider({
      async run(): Promise<RunHandle> {
        throw new Error("run boom")
      },
    }),
    mintRuntime: spyMint(box),
    failCleanup: async (a) => {
      cleaned.push(a)
    },
  })
  await assert.rejects(() => backend.create(makeSpec()), /run boom/)
  // The runtime WAS minted before run failed → the backend self-cleans it
  // (soft-delete the runtime + rm the broker dir).
  assert.equal(cleaned.length, 1)
  assert.equal(cleaned[0]!.runtimeId, box.args!.runtimeId)
  assert.equal(cleaned[0]!.workspaceId, "ws-1")
})

test("local backend: a throwing onRuntimeReady self-cleans + aborts create()", async () => {
  const box: { args?: MintArgs } = {}
  const cleaned: Array<{ runtimeId: string | null }> = []
  const backend = createLocalSandboxBackend({
    hostProvider: stubProvider(),
    mintRuntime: spyMint(box),
    failCleanup: async (a) => {
      cleaned.push(a)
    },
  })
  await assert.rejects(
    () =>
      backend.create(
        makeSpec({
          onRuntimeReady: async () => {
            throw new Error("persist boom")
          },
        })
      ),
    /persist boom/
  )
  assert.equal(cleaned.length, 1)
  assert.equal(cleaned[0]!.runtimeId, box.args!.runtimeId)
})

test("local handle: setTimeout throws unsupported (never a silent no-op)", async () => {
  const backend = createLocalSandboxBackend({
    hostProvider: stubProvider(),
    mintRuntime: spyMint({}),
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
    mintRuntime: spyMint({}),
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
    mintRuntime: spyMint({}),
  })
  const handle = await backend.create(makeSpec())
  await handle.kill()
  assert.equal(stopped, true)
})

test("local backend connect(): rejects a non-local ref", async () => {
  const backend = createLocalSandboxBackend({
    hostProvider: stubProvider(),
    mintRuntime: spyMint({}),
  })
  await assert.rejects(
    () =>
      backend.connect({
        adapter: "docker",
        mode: "resident",
        sandboxId: "sess-1",
        resourceId: "container-abc",
        runtimeId: "rt-1",
      }),
    SandboxBackendError
  )
})

test("local backend connect(): rebuilds a kill-capable handle from a ref", async () => {
  const backend = createLocalSandboxBackend({
    hostProvider: stubProvider(),
    mintRuntime: spyMint({}),
  })
  const handle = await backend.connect({
    adapter: "local",
    mode: "resident",
    sandboxId: "sess-9",
    resourceId: "",
    runtimeId: "rt-9",
    runtimeServiceId: "svc-9",
    hostPid: undefined,
  })
  assert.equal(handle.sandboxId, "sess-9")
  assert.equal(handle.runtimeLink.runtimeId, "rt-9")
  // No hostPid → isRunning false, kill is a safe no-op.
  assert.equal(await handle.isRunning(), false)
  await handle.kill() // must not throw
})
