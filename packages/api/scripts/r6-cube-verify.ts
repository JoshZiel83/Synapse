// THROWAWAY live e2e for the R6 off-box working-set fixes (#3 oversize streaming +
// #1 symlink-escape neutralize/exclude), against a REAL local Cube VM. Provisions a
// sandbox, plants a >10 MiB file + a symlink-to-/etc/passwd + a normal file in the VM,
// then drives the ACTUAL adapter.workingSet(handle).pull() into a host mirror and
// asserts: the oversize file round-trips WHOLE (streamed, never lost), the symlink is
// NOT materialized (excluded from the walk) and no /etc/passwd content leaks into the
// mirror, and the PullOutcome is durable (unreadable empty). NOT committed.
import { randomUUID } from "node:crypto"
import { mkdtemp, rm, stat, readdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WHOLE_SCOPE } from "@synapse/device-runtime"
import { makeCubesandboxBareAdapter } from "../src/modules/sandbox/cubesandbox-adapter.js"
import { getLiveBareDataPlane } from "../src/modules/sandbox/bare-dispatch.js"
import { coreInvokeBarePlane } from "../src/modules/sandbox/data-plane.js"
import type { ConfinementCtx } from "../src/modules/sandbox/data-plane.js"

const OPTS = {
  apiUrl: "http://127.0.0.1:13000",
  proxyUrl: "http://127.0.0.1:11080",
  domain: "cube.app",
  template: "tpl-529b45c345d9494496c59ff3",
  vmRoot: "/workspace",
  envdPort: 49983,
}

const WHOLE_W: ConfinementCtx = { scope: WHOLE_SCOPE, access: "write" }
const BIG_BYTES = 12 * 1024 * 1024 // > the 10 MiB maxReadBytes threshold → streaming path

let pass = 0
let fail = 0
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label} :: ${JSON.stringify(detail)?.slice(0, 500)}`)
  }
}

async function bash(plane: unknown, command: string): Promise<unknown> {
  const e = await coreInvokeBarePlane({
    plane: plane as never,
    builtinKind: "commandline",
    toolName: "bash",
    // working_directory is a VFS path (vmRoot-lowered): "/" → the VM vmRoot /workspace,
    // which exists (the default cwd /workspace/conversation does not on a fresh VM).
    args: { command, working_directory: "/" },
    ctx: WHOLE_W,
  })
  if (!e.ok) throw new Error(`bash failed: ${JSON.stringify(e).slice(0, 300)}`)
  return e
}

async function main(): Promise<void> {
  const adapter = makeCubesandboxBareAdapter({
    optionsOverride: OPTS,
    mintRuntime: (async () => ({}) as never) as never,
  })
  const spec = {
    sessionId: randomUUID(),
    workspaceId: randomUUID(),
    sandboxRoot: "/tmp/r6-cube-verify-vmroot",
    storageVolumeSubpath: undefined,
    fsHelperPath: "",
    serverOrigin: "",
    confineCommands: true,
    onRuntimeReady: async () => {},
  } as never

  console.log("① provision a real Cube sandbox…")
  const handle = await adapter.create(spec)
  const runtimeId = handle.runtimeLink.runtimeId
  console.log(`  resource=${handle.resourceId} runtime=${runtimeId}`)
  check("adapter.create returned a sandbox id", !!handle.resourceId)

  const mirrorRoot = await mkdtemp(join(tmpdir(), "r6-mirror-"))
  const mirrorMountDir = join(mirrorRoot, "conversation") // basename === the VFS subpath

  try {
    const plane = getLiveBareDataPlane(runtimeId)
    if (!plane) throw new Error("no live plane registered")

    console.log(
      "② plant VM files: 12MiB big.bin + symlink→/etc/passwd + normal.txt…"
    )
    await bash(
      plane,
      `set -e
       mkdir -p /workspace/conversation
       head -c ${BIG_BYTES} /dev/zero > /workspace/conversation/big.bin
       printf 'hello-normal' > /workspace/conversation/normal.txt
       ln -sf /etc/passwd /workspace/conversation/evil-link
       ls -la /workspace/conversation`
    )

    console.log("③ adapter.workingSet(handle).pull() → host mirror…")
    const bridge = adapter.workingSet(handle)
    const outcome = await bridge.pull({ dir: mirrorMountDir })
    await bridge.dispose?.()
    console.log(`  PullOutcome: ${JSON.stringify(outcome)}`)

    // ── #3 oversize streaming: big.bin round-trips WHOLE (never the R5 skip-and-lose) ──
    let bigSize = -1
    try {
      bigSize = (await stat(join(mirrorMountDir, "big.bin"))).size
    } catch {
      bigSize = -1
    }
    check(
      `#3 the 12MiB oversize file streamed into the mirror WHOLE (got ${bigSize} bytes)`,
      bigSize === BIG_BYTES,
      { expected: BIG_BYTES, got: bigSize }
    )
    check(
      "#3 the normal small file also pulled",
      (await stat(join(mirrorMountDir, "normal.txt"))
        .then((s) => s.size)
        .catch(() => -1)) === 12
    )
    check(
      "#3 PullOutcome is DURABLE (unreadable empty) so teardown may DELETE the VM",
      Array.isArray(outcome.unreadable) && outcome.unreadable.length === 0,
      outcome.unreadable
    )
    check(
      "#3 pulled set includes both real files",
      outcome.pulled.some((p) => p.endsWith("big.bin")) &&
        outcome.pulled.some((p) => p.endsWith("normal.txt")),
      outcome.pulled
    )

    // ── #1 symlink escape: evil-link is NOT materialized + /etc/passwd never exfiltrated ──
    const entries = await readdir(mirrorMountDir).catch(() => [] as string[])
    check(
      "#1 the VM symlink (evil-link) is EXCLUDED from the mirror (walk is find -type f)",
      !entries.includes("evil-link"),
      entries
    )
    // No mirror file may contain /etc/passwd's content (the root: line) — proving the
    // symlink target was never read/exfiltrated into the working set / CAS.
    let leaked = false
    for (const name of entries) {
      const buf = await readFile(join(mirrorMountDir, name)).catch(() =>
        Buffer.alloc(0)
      )
      if (buf.includes(Buffer.from("root:"))) leaked = true
    }
    check("#1 no /etc/passwd content leaked into ANY mirror file", !leaked)
  } finally {
    console.log("④ teardown (adapter kill → control DELETE) + mirror cleanup…")
    await handle.kill().catch((err) => console.log("  kill error:", err))
    await rm(mirrorRoot, { recursive: true, force: true }).catch(() => {})
    console.log("  done.")
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error("R6 VERIFY CRASHED:", err)
  process.exit(2)
})
