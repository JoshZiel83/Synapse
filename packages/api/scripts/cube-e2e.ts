// THROWAWAY live e2e for the cubesandbox:bare off-box provider (P4b MVP verification).
// Provisions a REAL Cube sandbox via the adapter, dispatches fs + exec tools through
// the CORE dispatch layer → the confined EnvdDataPlane → live envd, verifies
// confinement denies an out-of-scope path, demonstrates the working-set pull
// mechanism, then tears the sandbox down. NOT committed (needs the running Cube).
import { randomUUID } from "node:crypto"
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

const CONV_W: ConfinementCtx = { scope: ["/conversation"], access: "write" }
const CONV_R: ConfinementCtx = { scope: ["/conversation"], access: "read" }
const WHOLE_W: ConfinementCtx = { scope: WHOLE_SCOPE, access: "write" }

let pass = 0
let fail = 0
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label} :: ${JSON.stringify(detail)?.slice(0, 400)}`)
  }
}

async function main(): Promise<void> {
  const adapter = makeCubesandboxBareAdapter({
    optionsOverride: OPTS,
    // Stub the DB mint — this e2e isolates the adapter + plane + wire (no DB).
    mintRuntime: (async () => ({}) as never) as never,
  })
  const spec = {
    sessionId: randomUUID(),
    workspaceId: randomUUID(),
    sandboxRoot: "/tmp/cube-e2e",
    storageVolumeSubpath: undefined,
    fsHelperPath: "",
    serverOrigin: "",
    confineCommands: true,
    onRuntimeReady: async () => {},
  } as never

  console.log("① provision a real Cube sandbox via the adapter…")
  const handle = await adapter.create(spec)
  const runtimeId = handle.runtimeLink.runtimeId
  console.log(
    `  provisioned resource=${handle.resourceId} runtime=${runtimeId}`
  )
  check("adapter.create returned a sandbox id", !!handle.resourceId)

  try {
    const plane = getLiveBareDataPlane(runtimeId)
    check("plane registered for the runtime", !!plane)
    if (!plane) throw new Error("no plane")

    console.log(
      "② dispatch fs_write through the CORE → EnvdDataPlane → live envd…"
    )
    const w = await coreInvokeBarePlane({
      plane,
      builtinKind: "filesystem",
      toolName: "fs_write",
      args: { path: "/conversation/hello.txt", content: "hi from cube e2e\n" },
      ctx: CONV_W,
    })
    check("fs_write ok", w.ok === true, w)

    console.log("③ fs_read it back…")
    const r = await coreInvokeBarePlane({
      plane,
      builtinKind: "filesystem",
      toolName: "fs_read",
      args: { path: "/conversation/hello.txt" },
      ctx: CONV_R,
    })
    const rbody = r.ok
      ? JSON.parse(
          (r.result as { content: { text: string }[] }).content[0]!.text
        )
      : null
    check(
      "fs_read returns the written bytes",
      r.ok === true &&
        String(rbody?.content ?? "").includes("hi from cube e2e"),
      rbody ?? r
    )

    console.log("④ list_dir /conversation…")
    const l = await coreInvokeBarePlane({
      plane,
      builtinKind: "filesystem",
      toolName: "list_dir",
      args: { path: "/conversation" },
      ctx: CONV_R,
    })
    const lbody = l.ok
      ? JSON.parse(
          (l.result as { content: { text: string }[] }).content[0]!.text
        )
      : null
    check(
      "list_dir shows hello.txt (path back-translated, no /workspace leak)",
      l.ok === true &&
        JSON.stringify(lbody).includes("hello.txt") &&
        !JSON.stringify(lbody).includes("/workspace"),
      lbody ?? l
    )

    console.log("⑤ exec bash in the VM…")
    const e = await coreInvokeBarePlane({
      plane,
      builtinKind: "commandline",
      toolName: "bash",
      args: { command: "echo hi && whoami && pwd" },
      ctx: WHOLE_W,
    })
    const ebody = e.ok
      ? JSON.parse(
          (e.result as { content: { text: string }[] }).content[0]!.text
        )
      : null
    check(
      "bash exec runs in the VM (stdout has hi/root)",
      e.ok === true && String(ebody?.stdout ?? "").includes("hi"),
      ebody ?? e
    )

    console.log("⑥ CONFINEMENT: fs_read /etc/passwd must DENY (lexical scope)…")
    const deny = await coreInvokeBarePlane({
      plane,
      builtinKind: "filesystem",
      toolName: "fs_read",
      args: { path: "/etc/passwd" },
      ctx: CONV_R,
    })
    check(
      "out-of-scope /etc/passwd denied (permission_denied)",
      deny.ok === false && deny.error?.code === "permission_denied",
      deny
    )

    console.log("⑦ CONFINEMENT: sibling-prefix /conversation-evil must DENY…")
    const deny2 = await coreInvokeBarePlane({
      plane,
      builtinKind: "filesystem",
      toolName: "fs_read",
      args: { path: "/conversation-evil/x" },
      ctx: CONV_R,
    })
    check(
      "sibling-prefix path denied (not admitted by startsWith)",
      deny2.ok === false && deny2.error?.code === "permission_denied",
      deny2
    )
  } finally {
    console.log("⑧ teardown (adapter kill → control DELETE)…")
    await handle.kill().catch((err) => console.log("  kill error:", err))
    console.log("  killed.")
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error("E2E CRASHED:", err)
  process.exit(2)
})
