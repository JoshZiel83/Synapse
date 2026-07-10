// Mode-B (docker:bare) acceptance — DB-FREE, spawn-stubbed (aligned with
// docker-sandbox-backend.test.ts's fake docker CLI + the mint seam). Covers the
// SECURITY-CRITICAL gates: hardened run argv + ABSENCE assertions (B6), the
// literal-path subpath mounts / HOST-RCE trap, uid-parity (B7), runDockerCapture
// returns-not-rejects + backstop kill + resource_gone (B13), the docker exec
// argv, and host-side fs through the plane. NO :5432 / :55632.

import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  runDockerCapture,
  SandboxResourceGoneError,
  buildBareDockerRunArgs,
} from "./docker-sandbox-backend.js"
import type { SandboxSpec } from "./sandbox-backend.js"
import { WHOLE_SCOPE } from "@synapse/device-runtime"
import {
  makeDockerBareAdapter,
  buildDockerBareDescriptor,
  type DockerBareRunOptions,
} from "./adapter-registry.js"
import {
  createDockerBareDataPlane,
  coreInvokeBarePlane,
  type ConfinementCtx,
} from "./data-plane.js"

// Whole-scope confinement (root-jail) — fs ops resolve within the sandbox root;
// exec ignores the scope (it is separately container/bwrap-confined).
const WHOLE_SCOPE_CTX: ConfinementCtx = { scope: WHOLE_SCOPE, access: "write" }

// A fake `docker` CLI: records argv, scripts stdout/exit per subcommand, and (for
// the backstop test) can hang until kill() is called.
function fakeDocker(
  handler: (args: string[]) => {
    stdout?: string
    stderr?: string
    code?: number
    hang?: boolean
  }
) {
  const calls: string[][] = []
  const spawnImpl = ((_cmd: string, args: string[]) => {
    calls.push(args)
    const res = handler(args)
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: (sig?: string) => void
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    let exited = false
    const emitExit = (code: number) => {
      if (exited) return
      exited = true
      if (res.stdout) child.stdout.emit("data", Buffer.from(res.stdout))
      if (res.stderr) child.stderr.emit("data", Buffer.from(res.stderr))
      child.emit("exit", code)
    }
    // A hung child exits ONLY when killed (simulates a real `docker exec` that the
    // backstop SIGKILLs → the CLI child then reports exit).
    child.kill = () => emitExit(137)
    if (!res.hang) setImmediate(() => emitExit(res.code ?? 0))
    return child
  }) as never
  return { spawnImpl, calls }
}

async function makeSandboxRoot(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "synapse-dbare-"))
  const root = join(base, "sandbox")
  for (const sub of ["conversation", "actor", "actor-conversation"]) {
    await mkdir(join(root, sub), { recursive: true })
  }
  await writeFile(join(root, "conversation", "hi.txt"), "host-side bytes")
  return root
}

function bareRunOpts(
  over: Partial<DockerBareRunOptions> = {}
): DockerBareRunOptions {
  return {
    bareImage: "debian:bookworm-slim",
    storageVolume: "synapse_api_storage",
    runAsUid: typeof process.getuid === "function" ? process.getuid() : 0,
    pidsLimit: 512,
    memory: "1g",
    ...over,
  }
}

function baseSpec(root: string, over: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    workspaceId: "ws-1",
    sandboxRoot: root,
    storageVolumeSubpath:
      "files/sandboxes/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    fsHelperPath: "/x",
    serverOrigin: "http://api:3001",
    confineCommands: true,
    ...over,
  }
}

// ─────────────────────── B6 — hardened run argv + absence ─────────────────────

test("B6 — docker:bare `docker run` is HARDENED (no SYS_ADMIN / no unconfined / no secrets env / network none) + three literal-path subpath mounts (HOST-RCE trap)", async () => {
  const args = buildBareDockerRunArgs({
    opts: bareRunOpts(),
    spec: baseSpec("/unused"),
    containerName: "synapse-sbx-bare-x",
    mountPoints: ["conversation", "actor", "actor-conversation"],
  })
  // Hardened flags PRESENT.
  assert.ok(args.includes("-d"))
  assert.ok(args.includes("--init"))
  assert.deepEqual(
    [args[args.indexOf("--network") + 1]],
    ["none"],
    "network none by default"
  )
  assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL")
  assert.ok(args.includes("no-new-privileges"))
  assert.ok(args.includes("--pids-limit"))
  assert.ok(args.includes("--memory"))
  assert.ok(args.includes("--user"))
  // Keepalive, NOT a device-runtime.
  assert.deepEqual(args.slice(-2), ["sleep", "infinity"])

  // ABSENCE assertions — the resident's escapes must NOT appear.
  const joined = args.join(" ")
  assert.ok(!joined.includes("seccomp=unconfined"), "no seccomp=unconfined")
  assert.ok(!joined.includes("apparmor=unconfined"), "no apparmor=unconfined")
  assert.ok(!args.includes("SYS_ADMIN"), "no CAP_SYS_ADMIN")
  assert.ok(!args.includes("-e"), "no secrets env (-e) at all")
  assert.ok(!joined.includes("BOOTSTRAP"), "no bootstrap token")
  assert.ok(!joined.includes("FRP"), "no frp secrets")

  // HOST-RCE trap: THREE separate volume-subpath mounts at LITERAL paths; NEVER
  // the whole session root, NEVER a .synapse-internal staging dir.
  const mounts = args.filter((_, i) => args[i - 1] === "--mount")
  assert.equal(mounts.length, 3)
  const subRoot = "files/sandboxes/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
  for (const name of ["conversation", "actor", "actor-conversation"]) {
    assert.ok(
      mounts.some(
        (m) =>
          m.includes(`dst=/${name},`) &&
          m.includes(`volume-subpath=${subRoot}/${name}`)
      ),
      `mounts /${name} as a separate volume-subpath at its literal path`
    )
  }
  for (const m of mounts) {
    assert.ok(
      !m.includes("dst=/sandbox-root"),
      "never mounts the whole session root"
    )
    assert.ok(
      !m.includes(".synapse-internal"),
      "never mounts the internal staging namespace"
    )
    // Each mount's volume-subpath ends in a mount-point NAME, never the bare
    // session subpath root (which would expose the sibling staging namespace).
    assert.ok(
      !new RegExp(`volume-subpath=${subRoot}(,|$)`).test(m),
      "each mount is a mount-point SUBPATH, not the session root"
    )
  }
})

// ─────────────────────── B7 — uid-parity fail-fast ───────────────────────────

test("B7 — docker:bare create() fails fast on a uid-parity violation (runAsUid != API uid)", async (t) => {
  if (typeof process.getuid !== "function")
    return t.skip("no getuid on this platform")
  const root = await makeSandboxRoot()
  const { spawnImpl, calls } = fakeDocker(() => ({ stdout: "cid\n" }))
  const adapter = makeDockerBareAdapter({
    dockerSpawnImpl: spawnImpl,
    optionsOverride: bareRunOpts({ runAsUid: process.getuid()! + 1 }),
    mintRuntime: (async () => ({ assignedIds: {} })) as never,
  })
  await assert.rejects(
    () => adapter.create(baseSpec(root)),
    /uid-parity violation/
  )
  assert.equal(calls.length, 0, "no docker call before the uid gate")
})

// ─────────────────────── adapter create → hardened run + mint ─────────────────

test("docker:bare create() runs the hardened container, probes timeout/bash, mints adapter='docker' + docker-exec endpoint", async () => {
  const root = await makeSandboxRoot()
  const runArgvSeen: string[][] = []
  const { spawnImpl } = fakeDocker((args) => {
    if (args[0] === "rm") return { code: 0 }
    if (args[0] === "run") {
      runArgvSeen.push(args)
      return { stdout: "container-bare-1\n", code: 0 }
    }
    if (args[0] === "exec") return { code: 0 } // probe ok
    return { code: 0 }
  })
  let mintArgs: Record<string, unknown> | null = null
  const adapter = makeDockerBareAdapter({
    dockerSpawnImpl: spawnImpl,
    optionsOverride: bareRunOpts(),
    mintRuntime: (async (a: Record<string, unknown>) => {
      mintArgs = a
      return { assignedIds: {} }
    }) as never,
  })
  const staged: string[] = []
  const handle = await adapter.create(
    baseSpec(root, {
      onRuntimeReady: async (id) => {
        staged.push(`runtime:${id}`)
      },
    })
  )
  assert.equal(handle.adapter, "docker")
  assert.equal(handle.mode, "bare")
  assert.equal(handle.resourceId, "container-bare-1")
  assert.equal(handle.runtimeLink.mode, "bare")
  assert.match(
    (handle.runtimeLink as { dataPlaneEndpoint: string }).dataPlaneEndpoint,
    /^docker-exec:container-bare-1$/
  )
  assert.equal(mintArgs!.adapter, "docker")
  assert.match(String(mintArgs!.dataPlaneEndpoint), /^docker-exec:/)
  assert.ok(
    staged.some((s) => s.startsWith("runtime:")),
    "onRuntimeReady fired (mount sandbox_id back-fill)"
  )
  assert.ok(runArgvSeen.length === 1)
})

// ─────────────────────── runDockerCapture semantics ──────────────────────────

test("runDockerCapture — a NON-ZERO exit is a RESULT (not a reject)", async () => {
  const { spawnImpl } = fakeDocker(() => ({
    stdout: "partial\n",
    stderr: "boom",
    code: 3,
  }))
  const res = await runDockerCapture(spawnImpl, ["exec", "cid", "false"])
  assert.equal(res.code, 3)
  assert.equal(res.stdout, "partial\n")
  assert.equal(res.stderr, "boom")
  assert.equal(res.killed, false)
})

test("runDockerCapture — exit 125 + 'No such container' rejects with SandboxResourceGoneError (B13)", async () => {
  const { spawnImpl } = fakeDocker(() => ({
    stderr: "Error: No such container: cid",
    code: 125,
  }))
  await assert.rejects(
    () => runDockerCapture(spawnImpl, ["exec", "cid", "true"]),
    (err: unknown) => {
      assert.ok(err instanceof SandboxResourceGoneError)
      assert.equal((err as SandboxResourceGoneError).code, "resource_gone")
      return true
    }
  )
})

test("runDockerCapture — API-side backstop SIGKILLs the CLI child AND `docker kill`s the container on a hang", async () => {
  const { spawnImpl, calls } = fakeDocker((args) => {
    if (args[0] === "exec") return { hang: true }
    return { code: 0 } // the `docker kill` call
  })
  const res = await runDockerCapture(
    spawnImpl,
    ["exec", "-w", "/conversation", "cid", "sleep", "999"],
    { timeoutMs: 20, backstopGraceMs: 20, containerId: "cid" }
  )
  assert.equal(res.killed, true, "backstop set killed")
  assert.ok(
    calls.some((c) => c[0] === "kill" && c[1] === "cid"),
    "backstop `docker kill cid` was issued"
  )
})

// ─────────────────────── data plane: docker exec argv ────────────────────────

test("docker:bare plane exec → `docker exec -w <cwd> <cid> timeout -k 5 -s TERM <secs> bash -c <cmd>`", async () => {
  const root = await makeSandboxRoot()
  let execArgv: string[] | null = null
  const { spawnImpl } = fakeDocker((args) => {
    if (args[0] === "exec") {
      execArgv = args
      return { stdout: "hi\n", code: 0 }
    }
    return { code: 0 }
  })
  const plane = createDockerBareDataPlane({
    sandboxRoot: root,
    descriptor: buildDockerBareDescriptor({ search: false }),
    containerId: "cid-9",
    spawnImpl,
  })
  const res = await coreInvokeBarePlane({
    plane,
    builtinKind: "commandline",
    toolName: "bash",
    args: { command: "echo hi", working_directory: "/conversation" },
    ctx: WHOLE_SCOPE_CTX,
  })
  assert.equal(res.ok, true)
  assert.ok(execArgv)
  const a = execArgv as unknown as string[]
  assert.equal(a[0], "exec")
  assert.equal(a[1], "-w")
  assert.equal(a[2], "/conversation")
  assert.equal(a[3], "cid-9")
  assert.equal(a[4], "timeout")
  assert.equal(a[5], "-k")
  assert.equal(a[6], "5")
  assert.equal(a[7], "-s")
  assert.equal(a[8], "TERM")
  assert.deepEqual(a.slice(10), ["bash", "-c", "echo hi"])
})

test("docker:bare plane fs is HOST-SIDE — fs_read reads the host file with NO docker call", async () => {
  const root = await makeSandboxRoot()
  let dockerCalled = false
  const { spawnImpl } = fakeDocker(() => {
    dockerCalled = true
    return { code: 0 }
  })
  const plane = createDockerBareDataPlane({
    sandboxRoot: root,
    descriptor: buildDockerBareDescriptor({ search: false }),
    containerId: "cid-fs",
    spawnImpl,
  })
  const res = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "fs_read",
    args: { path: "/conversation/hi.txt" },
    ctx: WHOLE_SCOPE_CTX,
  })
  assert.equal(res.ok, true)
  const body = JSON.parse(
    (res.result as { content: { text: string }[] }).content[0]!.text
  )
  assert.equal(body.content, "host-side bytes")
  assert.equal(dockerCalled, false, "fs ops NEVER shell out to docker")
})

test("docker:bare plane exec — resource_gone surfaces as runtime_constraint + resource_gone detail", async () => {
  const root = await makeSandboxRoot()
  const { spawnImpl } = fakeDocker((args) => {
    if (args[0] === "exec")
      return { stderr: "No such container: cid-gone", code: 125 }
    return { code: 0 }
  })
  const plane = createDockerBareDataPlane({
    sandboxRoot: root,
    descriptor: buildDockerBareDescriptor({ search: false }),
    containerId: "cid-gone",
    spawnImpl,
  })
  const res = await coreInvokeBarePlane({
    plane,
    builtinKind: "commandline",
    toolName: "bash",
    args: { command: "true", working_directory: "/conversation" },
    ctx: WHOLE_SCOPE_CTX,
  })
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, "runtime_constraint")
  assert.equal(
    (res.error?.details as { resource_gone?: boolean })?.resource_gone,
    true
  )
})
