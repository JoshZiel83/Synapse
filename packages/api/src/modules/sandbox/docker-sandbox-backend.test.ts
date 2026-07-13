import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { assertIsoInstant } from "@synapse/shared/datetime"
import {
  createDockerSandboxBackend,
  createDockerReconnectBackend,
  reapDockerSandboxOrphans,
  probeDockerContainerLiveness,
} from "./docker-sandbox-backend.js"
import { SandboxBackendError, type SandboxSpec } from "./sandbox-backend.js"
import { toSandboxVolumeSubpath } from "./service.js"

// A fake `docker` CLI: records argv, returns scripted stdout/exit per subcommand.
function fakeDocker(
  handler: (args: string[]) => {
    stdout?: string
    stderr?: string
    code?: number
  }
) {
  const calls: string[][] = []
  const spawnImpl = ((_cmd: string, args: string[]) => {
    calls.push(args)
    const res = handler(args)
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    setImmediate(() => {
      if (res.stdout) child.stdout.emit("data", Buffer.from(res.stdout))
      if (res.stderr) child.stderr.emit("data", Buffer.from(res.stderr))
      child.emit("exit", res.code ?? 0)
    })
    return child
  }) as never
  return { spawnImpl, calls }
}

function baseSpec(over: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    sessionId: "11111111-2222-3333-4444-555555555555",
    workspaceId: "ws-1",
    sandboxRoot: "/app/storage/files/sandboxes/sess",
    // Session root relative to the storage volume mount (/app/storage) — what
    // the spine's sandboxVolumeSubpathFor would compute for STORAGE_DIR
    // =/app/storage/files. The container must mount THIS, not "sandboxes/<id>".
    storageVolumeSubpath:
      "files/sandboxes/11111111-2222-3333-4444-555555555555",
    fsHelperPath: "/x",
    serverOrigin: "http://api:3001",
    confineCommands: true,
    ...over,
  }
}

const baseOpts = {
  image: "synapse-device-runtime:test",
  network: "synapse-sandbox-egress",
  storageVolume: "synapse_api_storage",
  serverOrigin: "http://api:3001",
  // Docker sandboxes are reachable only over frp (no co-located loopback), so
  // the backend always runs with tunnel=frp + a shared token.
  tunnel: "frp" as const,
  tunnelAuthToken: "tok-base",
}

// A deterministic pairing stub so create() runs without a live DB.
function fakePairing(over: Record<string, string> = {}) {
  return async () => ({
    pendingRuntimeId: "pend-1",
    bootstrapToken: "tok",
    pairingSessionId: "pair-1",
    expiresAt: assertIsoInstant("2099-01-01T00:00:00.000Z"),
    ...over,
  })
}

test("docker create(): builds a correct `docker run` argv + completes the staged callbacks", async () => {
  const { spawnImpl, calls } = fakeDocker((args) => {
    if (args[0] === "inspect") return { code: 1, stderr: "no such container" }
    if (args[0] === "run") return { stdout: "container-abc123\n" }
    return { stdout: "" }
  })
  const staged: string[] = []
  const backend = createDockerSandboxBackend({
    ...baseOpts,
    spawnImpl,
    createPairing: fakePairing(),
    // Skip the DB poll — simulate the container bootstrapping.
    pollBootstrapConsumed: async () => ({
      runtimeId: "dev-1",
      runtimeServiceId: "svc-1",
    }),
  })
  const handle = await backend.create(
    baseSpec({
      onRuntimeReady: async (id) => {
        staged.push(`device:${id}`)
      },
    })
  )

  const runArgs = calls.find((c) => c[0] === "run")!
  assert.ok(runArgs, "docker run was invoked")
  assert.ok(runArgs.includes("-d"), "detached")
  assert.ok(
    runArgs.includes("seccomp=unconfined") &&
      runArgs.includes("apparmor=unconfined"),
    "seccomp+apparmor unconfined"
  )
  assert.ok(runArgs.includes("SYS_ADMIN"), "cap SYS_ADMIN")
  assert.ok(!runArgs.includes("NET_ADMIN"), "NET_ADMIN intentionally absent")
  assert.ok(
    runArgs.some((a) =>
      a.includes(
        "volume-subpath=files/sandboxes/11111111-2222-3333-4444-555555555555"
      )
    ),
    "mounts the session subpath RELATIVE to the volume mount (files/sandboxes/<id>, not sandboxes/<id>)"
  )
  assert.ok(
    runArgs.some((a) => a === "--fs-root=/sandbox-root"),
    "full run command override with fs-root"
  )
  assert.ok(
    runArgs.includes("--cmd-sandbox") &&
      runArgs.includes("--cmd-sandbox-share-net"),
    "cmd-sandbox + share-net flags"
  )
  assert.ok(
    runArgs.some((a) => a === "SYNAPSE_DEVICE_CMD_SANDBOX_SHARE_NET=1"),
    "share-net env"
  )
  assert.ok(
    runArgs.some((a) => a === "SYNAPSE_TUNNEL_MODE=frp"),
    "explicit frp tunnel mode env (never falls back to noop inside the container)"
  )
  assert.equal(handle.adapter, "docker")
  assert.equal(handle.resourceId, "container-abc123")
  assert.deepEqual(staged, ["device:dev-1"])
})

test("docker create(): tunnel=frp injects SYNAPSE_TUNNEL_* env", async () => {
  const { spawnImpl, calls } = fakeDocker((args) => {
    if (args[0] === "inspect") return { code: 1 }
    if (args[0] === "run") return { stdout: "cid\n" }
    return { stdout: "" }
  })
  const backend = createDockerSandboxBackend({
    ...baseOpts,
    tunnel: "frp",
    tunnelAuthToken: "tok-123",
    tunnelInternalBaseUrl: "http://my-edge.example:8080",
    spawnImpl,
    createPairing: fakePairing(),
    pollBootstrapConsumed: async () => ({
      runtimeId: "d",
      runtimeServiceId: "s",
    }),
  })
  await backend.create(baseSpec())
  const runArgs = calls.find((c) => c[0] === "run")!
  assert.ok(
    runArgs.some((a) => a === "SYNAPSE_TUNNEL_SERVER_ADDR=tunnel-edge"),
    "tunnel server addr"
  )
  assert.ok(
    runArgs.some((a) => a === "SYNAPSE_TUNNEL_AUTH_TOKEN=tok-123"),
    "tunnel auth token"
  )
  assert.ok(
    runArgs.some((a) => a === "SYNAPSE_TUNNEL_VHOST_HOST=tunnel-edge"),
    "vhost pinned to tunnel-edge"
  )
  assert.ok(
    runArgs.some(
      (a) =>
        a === "SYNAPSE_TUNNEL_INTERNAL_BASE_URL=http://my-edge.example:8080"
    ),
    "internal base url passed through for a non-default edge"
  )
})

test("docker create(): omits SYNAPSE_TUNNEL_INTERNAL_BASE_URL when not configured", async () => {
  const { spawnImpl, calls } = fakeDocker((args) => {
    if (args[0] === "inspect") return { code: 1 }
    if (args[0] === "run") return { stdout: "cid\n" }
    return { stdout: "" }
  })
  const backend = createDockerSandboxBackend({
    ...baseOpts,
    tunnel: "frp",
    tunnelAuthToken: "tok-123",
    spawnImpl,
    createPairing: fakePairing(),
    pollBootstrapConsumed: async () => ({
      runtimeId: "d",
      runtimeServiceId: "s",
    }),
  })
  await backend.create(baseSpec())
  const runArgs = calls.find((c) => c[0] === "run")!
  assert.ok(
    !runArgs.some((a) => a.startsWith("SYNAPSE_TUNNEL_INTERNAL_BASE_URL=")),
    "no internal-base-url env when unset (adapter falls back to the default)"
  )
})

// ── R4 #2: a connect-only docker backend needs no provision env.

test("createDockerReconnectBackend: connect + kill by container id (no provision opts)", async () => {
  const seen: string[][] = []
  const { spawnImpl } = fakeDocker((args) => {
    seen.push(args)
    if (args[0] === "inspect") return { stdout: "true\n" }
    return { stdout: "" }
  })
  // Note: NO image/network/volume/frp opts — just the spawn seam.
  const backend = createDockerReconnectBackend({ spawnImpl })
  const handle = await backend.connect({
    adapter: "docker",
    mode: "resident",
    sandboxId: "sess-reconnect",
    resourceId: "container-reconnect",
    runtimeId: "dev-x",
  })
  assert.equal(await handle.isRunning(), true)
  await handle.kill()
  assert.ok(
    seen.some((c) => c[0] === "stop" && c.includes("container-reconnect")),
    "docker stop called via reconnect backend"
  )
  assert.ok(
    seen.some((c) => c[0] === "rm" && c.includes("container-reconnect")),
    "docker rm called via reconnect backend"
  )
})

// ── R3.4: docker tristate liveness distinguishes gone (dead) from error (unknown)

test("R3.4 probeDockerContainerLiveness: Running=true→alive, false→dead", async () => {
  const aliveDocker = fakeDocker((a) =>
    a[0] === "inspect" ? { stdout: "true\n" } : { stdout: "" }
  )
  assert.equal(
    await probeDockerContainerLiveness(aliveDocker.spawnImpl, "cid"),
    "alive"
  )
  const deadDocker = fakeDocker((a) =>
    a[0] === "inspect" ? { stdout: "false\n" } : { stdout: "" }
  )
  assert.equal(
    await probeDockerContainerLiveness(deadDocker.spawnImpl, "cid"),
    "dead"
  )
})

test("R3.4 probeDockerContainerLiveness: a removed container → 'dead'", async () => {
  const gone = fakeDocker((a) =>
    a[0] === "inspect"
      ? { code: 1, stderr: "Error: No such object: cid" }
      : { stdout: "" }
  )
  assert.equal(
    await probeDockerContainerLiveness(gone.spawnImpl, "cid"),
    "dead"
  )
})

test("R3.4 probeDockerContainerLiveness: a daemon/transport error → 'unknown' (NOT dead)", async () => {
  // A docker daemon that is unreachable must NOT be collapsed to 'dead' — that is
  // exactly the ambiguous-false the tristate exists to prevent (it would reap a
  // possibly-live container). Non-"no such" non-zero exit ⇒ 'unknown'.
  const daemonDown = fakeDocker((a) =>
    a[0] === "inspect"
      ? {
          code: 1,
          stderr:
            "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
        }
      : { stdout: "" }
  )
  assert.equal(
    await probeDockerContainerLiveness(daemonDown.spawnImpl, "cid"),
    "unknown"
  )
  // A spawn 'error' (docker CLI missing) is likewise 'unknown', never 'dead'.
  const spawnErr = ((_cmd: string, _args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    setImmediate(() => child.emit("error", new Error("spawn docker ENOENT")))
    return child
  }) as never
  assert.equal(await probeDockerContainerLiveness(spawnErr, "cid"), "unknown")
})

test("createDockerReconnectBackend: create() is unsupported (connect-only)", async () => {
  const { spawnImpl } = fakeDocker(() => ({ stdout: "" }))
  const backend = createDockerReconnectBackend({ spawnImpl })
  await assert.rejects(
    () => backend.create(baseSpec()),
    /connect-only|unsupported/
  )
})

test("createDockerReconnectBackend: rejects a non-docker ref + a ref without container id", async () => {
  const { spawnImpl } = fakeDocker(() => ({ stdout: "" }))
  const backend = createDockerReconnectBackend({ spawnImpl })
  await assert.rejects(
    () =>
      backend.connect({
        adapter: "local",
        mode: "resident",
        sandboxId: "s",
        resourceId: "c",
        runtimeId: "d",
      }),
    SandboxBackendError
  )
  await assert.rejects(
    () =>
      backend.connect({
        adapter: "docker",
        mode: "resident",
        sandboxId: "s",
        resourceId: "",
        runtimeId: "d",
      }),
    /no container id/
  )
})

// ── Fix #2: create() must self-clean every fact it made when it fails before
// returning a handle (the spine's create() catch only fires when a handle was
// returned). These assert via the injected failCleanup spy — no DB needed.

test("docker create(): bootstrap timeout self-cleans container + pairing + device", async () => {
  const { spawnImpl } = fakeDocker((args) => {
    if (args[0] === "inspect") return { code: 1 }
    if (args[0] === "run") return { stdout: "container-leak\n" }
    if (args[0] === "logs") return { stdout: "boom" }
    return { stdout: "" }
  })
  const cleaned: Array<Record<string, unknown>> = []
  const backend = createDockerSandboxBackend({
    ...baseOpts,
    spawnImpl,
    createPairing: fakePairing(),
    pollBootstrapConsumed: async () => {
      throw new Error("bootstrap never consumed")
    },
    failCleanup: async (a) => {
      cleaned.push(a)
    },
  })
  await assert.rejects(() => backend.create(baseSpec()), /did not bootstrap/)
  // The container WAS created (docker run returned an id) but the runtime never
  // bootstrapped → cleanup reaps the container + cancels the pairing, runtimeId null.
  assert.deepEqual(cleaned, [
    {
      workspaceId: "ws-1",
      containerId: "container-leak",
      pairingSessionId: "pair-1",
      runtimeId: null,
    },
  ])
})

test("docker create(): a throwing onDeviceClaimed self-cleans the bootstrapped device", async () => {
  const { spawnImpl } = fakeDocker((args) => {
    if (args[0] === "inspect") return { code: 1 }
    if (args[0] === "run") return { stdout: "container-x\n" }
    return { stdout: "" }
  })
  const cleaned: Array<Record<string, unknown>> = []
  const backend = createDockerSandboxBackend({
    ...baseOpts,
    spawnImpl,
    createPairing: fakePairing(),
    pollBootstrapConsumed: async () => ({
      runtimeId: "dev-leak",
      runtimeServiceId: "svc",
    }),
    failCleanup: async (a) => {
      cleaned.push(a)
    },
  })
  await assert.rejects(
    () =>
      backend.create(
        baseSpec({
          onRuntimeReady: async () => {
            throw new Error("persist boom")
          },
        })
      ),
    /persist boom/
  )
  assert.deepEqual(cleaned, [
    {
      workspaceId: "ws-1",
      containerId: "container-x",
      pairingSessionId: "pair-1",
      runtimeId: "dev-leak",
    },
  ])
})

test("docker connect(): rejects non-docker ref + requires a container id", async () => {
  const { spawnImpl } = fakeDocker(() => ({ stdout: "" }))
  const backend = createDockerSandboxBackend({ ...baseOpts, spawnImpl })
  await assert.rejects(
    () =>
      backend.connect({
        adapter: "local",
        mode: "resident",
        sandboxId: "s",
        resourceId: "",
        runtimeId: "d",
      }),
    SandboxBackendError
  )
  await assert.rejects(
    () =>
      backend.connect({
        adapter: "docker",
        mode: "resident",
        sandboxId: "s",
        resourceId: "",
        runtimeId: "d",
      }),
    /no container id/
  )
})

test("docker connect: empty runtimeId still kills the container (half-provisioned crash recovery)", async () => {
  const seen: string[][] = []
  const { spawnImpl } = fakeDocker((args) => {
    seen.push(args)
    return { stdout: "" }
  })
  const backend = createDockerSandboxBackend({ ...baseOpts, spawnImpl })
  // Crash after `docker run` but before the runtime was ready: container id known,
  // runtimeId is "". teardown must still reap the container.
  const handle = await backend.connect({
    adapter: "docker",
    mode: "resident",
    sandboxId: "sess-half",
    resourceId: "container-half",
    runtimeId: "",
  })
  await handle.kill()
  assert.ok(
    seen.some((c) => c[0] === "rm" && c.includes("container-half")),
    "container reaped even without a device id"
  )
})

test("docker handle: kill() stops + removes the container; isRunning inspects", async () => {
  const seen: string[][] = []
  const { spawnImpl } = fakeDocker((args) => {
    seen.push(args)
    if (args[0] === "inspect") return { stdout: "true\n" }
    return { stdout: "" }
  })
  const backend = createDockerSandboxBackend({ ...baseOpts, spawnImpl })
  const handle = await backend.connect({
    adapter: "docker",
    mode: "resident",
    sandboxId: "sess-9",
    resourceId: "container-xyz",
    runtimeId: "dev-9",
    runtimeServiceId: "svc-9",
  })
  assert.equal(handle.resourceId, "container-xyz")
  assert.equal(await handle.isRunning(), true)
  await handle.kill()
  assert.ok(
    seen.some((c) => c[0] === "stop" && c.includes("container-xyz")),
    "docker stop called"
  )
  assert.ok(
    seen.some((c) => c[0] === "rm" && c.includes("container-xyz")),
    "docker rm called"
  )
})

test("docker handle: setTimeout + getHost throw (no silent no-op / fake host)", async () => {
  const { spawnImpl } = fakeDocker(() => ({ stdout: "" }))
  const backend = createDockerSandboxBackend({ ...baseOpts, spawnImpl })
  const handle = await backend.connect({
    adapter: "docker",
    mode: "resident",
    sandboxId: "s",
    resourceId: "c",
    runtimeId: "d",
  })
  await assert.rejects(() => handle.setTimeout(1000), SandboxBackendError)
  assert.throws(() => handle.getHost(8080), SandboxBackendError)
})

// ── compose-layout coverage (Fix #1): the volume-subpath the container mounts
// must be the session root RELATIVE to the storage volume's mount point, NOT
// relative to STORAGE_DIR. This is the bug the reviewer caught — a hardcoded
// `sandboxes/<id>` mounted the wrong dir when STORAGE_DIR sat below the volume
// root (the reference compose: STORAGE_DIR=/app/storage/files, volume mounted at
// /app/storage → correct subpath is `files/sandboxes/<id>`).

test("layout: toSandboxVolumeSubpath nests STORAGE_DIR under the volume mount (reference compose)", () => {
  assert.equal(
    toSandboxVolumeSubpath({
      storageDir: "/app/storage/files",
      mountPoint: "/app/storage",
      sessionId: "abc",
    }),
    "files/sandboxes/abc",
    "files/ prefix carried so the container sees the materialized dir"
  )
})

test("layout: toSandboxVolumeSubpath is `sandboxes/<id>` only when STORAGE_DIR == the mount point", () => {
  assert.equal(
    toSandboxVolumeSubpath({
      storageDir: "/data",
      mountPoint: "/data",
      sessionId: "abc",
    }),
    "sandboxes/abc"
  )
})

test("layout: toSandboxVolumeSubpath fails loud when STORAGE_DIR is outside the volume mount", () => {
  assert.throws(
    () =>
      toSandboxVolumeSubpath({
        storageDir: "/var/lib/other",
        mountPoint: "/app/storage",
        sessionId: "abc",
      }),
    /not under the sandbox storage|volume-subpath/
  )
})

test("docker create(): spec without storageVolumeSubpath fails loud (never mounts the wrong dir)", async () => {
  const { spawnImpl } = fakeDocker((args) => {
    if (args[0] === "inspect") return { code: 1 }
    if (args[0] === "run") return { stdout: "cid\n" }
    return { stdout: "" }
  })
  const cleaned: Array<Record<string, unknown>> = []
  const backend = createDockerSandboxBackend({
    ...baseOpts,
    spawnImpl,
    createPairing: fakePairing(),
    pollBootstrapConsumed: async () => ({
      runtimeId: "d",
      runtimeServiceId: "s",
    }),
    failCleanup: async (a) => {
      cleaned.push(a)
    },
  })
  // Omit storageVolumeSubpath → buildDockerRunArgs must reject rather than mount
  // a guessed path. The failure happens after the pairing is created, so cleanup
  // cancels the pairing (no container, no device yet).
  const spec = baseSpec()
  delete (spec as Partial<SandboxSpec>).storageVolumeSubpath
  await assert.rejects(
    () => backend.create(spec),
    /storageVolumeSubpath is required/
  )
  assert.deepEqual(cleaned, [
    {
      workspaceId: "ws-1",
      containerId: null,
      pairingSessionId: "pair-1",
      runtimeId: null,
    },
  ])
})

// ── Fix #4: reap label-only docker orphans (a container started before its id
// was persisted, so the DB-driven reconciler can't build a killable ref).

test("reapDockerSandboxOrphans: removes labeled containers whose session has no live mount", async () => {
  const { spawnImpl, calls } = fakeDocker((args) => {
    if (args[0] === "ps") {
      // two labeled containers: one live (kept), one orphaned (removed).
      return { stdout: "cid-live sess-live\ncid-orphan sess-orphan\n" }
    }
    return { stdout: "" }
  })
  const res = await reapDockerSandboxOrphans(new Set(["sess-live"]), {
    spawnImpl,
  })
  assert.deepEqual(res.removed, ["sess-orphan"])
  assert.deepEqual(res.kept, ["sess-live"])
  // the live container is never rm'd; only the orphan is.
  assert.ok(
    calls.some((c) => c[0] === "rm" && c.includes("cid-orphan")),
    "orphan container removed"
  )
  assert.ok(
    !calls.some((c) => c[0] === "rm" && c.includes("cid-live")),
    "live container kept"
  )
})

test("reapDockerSandboxOrphans: no labeled containers → no-op", async () => {
  const { spawnImpl, calls } = fakeDocker((args) => {
    if (args[0] === "ps") return { stdout: "\n" }
    return { stdout: "" }
  })
  const res = await reapDockerSandboxOrphans(new Set(), { spawnImpl })
  assert.deepEqual(res, { removed: [], kept: [] })
  assert.ok(!calls.some((c) => c[0] === "rm"), "nothing removed")
})

test("reapDockerSandboxOrphans: a `docker ps` failure is swallowed (best-effort)", async () => {
  const { spawnImpl } = fakeDocker((args) => {
    if (args[0] === "ps") return { code: 1, stderr: "daemon down" }
    return { stdout: "" }
  })
  const res = await reapDockerSandboxOrphans(new Set(["x"]), { spawnImpl })
  assert.deepEqual(res, { removed: [], kept: [] })
})
