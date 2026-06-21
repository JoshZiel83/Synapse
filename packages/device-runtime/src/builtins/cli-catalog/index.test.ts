import test from "node:test"
import assert from "node:assert/strict"
import { createCliCatalog } from "./index.js"
import type { NormalizedCli, CliPrereq } from "./index.js"
import type { ResolvedTerminalEnvironment } from "../../terminal/types.js"

function env(
  platform: "linux" | "darwin" | "win32",
  present: string[]
): {
  env: ResolvedTerminalEnvironment
  resolver: (n: string) => string | null
  calls: () => number
} {
  let calls = 0
  const set = new Set(present)
  const resolved = {
    platform,
    arch: "x64",
    osEnv: { PATH: "/usr/bin" },
    bash: "/bin/bash",
    powershell: null,
    loginShells: [],
    locale: { lang: null, lcAll: null, lcCtype: null, utf8: true },
    probes: { git: null, python: null, python3: null, node: null },
  } as unknown as ResolvedTerminalEnvironment
  return {
    env: resolved,
    resolver: (n) => {
      calls++
      return set.has(n) ? `/usr/bin/${n}` : null
    },
    calls: () => calls,
  }
}

const CAT: NormalizedCli[] = [
  {
    cliName: "audacity",
    entryPoint: "cli-anything-audacity",
    kind: "harness-cli",
    install: { manager: "pip", cmd: "x" },
    displayName: "Audacity",
    description: "",
    category: "audio",
  },
  {
    cliName: "comfyui",
    entryPoint: "cli-anything-comfyui",
    kind: "harness-cli",
    install: { manager: "pip", cmd: "x" },
    displayName: "ComfyUI",
    description: "",
    category: "ai",
  },
  {
    cliName: "iterm2",
    entryPoint: "cli-anything-iterm2",
    kind: "harness-cli",
    install: { manager: "pip", cmd: "x" },
    displayName: "iTerm2",
    description: "",
    category: "devops",
  },
  {
    cliName: "mermaid",
    entryPoint: "cli-anything-mermaid",
    kind: "harness-cli",
    install: { manager: "pip", cmd: "x" },
    displayName: "Mermaid",
    description: "",
    category: "diagrams",
  },
]
const OVR: CliPrereq[] = [
  {
    cliName: "audacity",
    entryPoint: "cli-anything-audacity",
    underlying: { binary: ["sox"] },
    credential: false,
    reviewed: true,
  },
  {
    cliName: "comfyui",
    entryPoint: "cli-anything-comfyui",
    underlying: { service: [{ url: "http://localhost:8188" }] },
    credential: false,
    reviewed: true,
  },
  {
    cliName: "iterm2",
    entryPoint: "cli-anything-iterm2",
    underlying: { platform: ["darwin"] },
    credential: false,
    reviewed: true,
  },
  {
    cliName: "mermaid",
    entryPoint: "cli-anything-mermaid",
    underlying: {},
    credential: false,
    reviewed: true,
  },
]
const mk = (e: ReturnType<typeof env>, svc = true) =>
  createCliCatalog({
    catalog: CAT,
    overlay: OVR,
    pathResolver: (n, _e, _p) => e.resolver(n),
    probeService: async () => svc,
    probeVersion: async () => null,
  })
// single-CLI (audacity-only) catalog to isolate per-CLI assertions
const mk1 = (e: ReturnType<typeof env>) =>
  createCliCatalog({
    catalog: [CAT[0]!],
    overlay: [OVR[0]!],
    pathResolver: (n, _e, _p) => e.resolver(n),
    probeService: async () => true,
    probeVersion: async () => null,
  })

test("availableClis is keyed by entryPoint, value carries cliName + source", async () => {
  const e = env("linux", ["sox", "cli-anything-audacity"])
  const map = await mk(e).getAvailableClis(e.env)
  assert.ok(map["cli-anything-audacity"], "keyed by entryPoint, not cliName")
  assert.equal(map["audacity"], undefined)
  assert.equal(map["cli-anything-audacity"]!.available, true)
  assert.equal(map["cli-anything-audacity"]!.cliName, "audacity")
  assert.equal(map["cli-anything-audacity"]!.source, "harness-cli")
  assert.equal(map["cli-anything-audacity"]!.prereq, "ok")
})

test("underlying satisfied but harness not on PATH → installable (not available)", async () => {
  const e = env("linux", ["sox"]) // sox present, entryPoint absent
  const cat = mk1(e)
  const map = await cat.getAvailableClis(e.env)
  assert.equal(map["cli-anything-audacity"]!.available, false)
  assert.equal(map["cli-anything-audacity"]!.prereq, "installable")
  const targets = await cat.getInstallTargets(e.env)
  assert.deepEqual(
    targets.map((t) => t.cliName),
    ["audacity"]
  )
})

test("missing underlying binary → not exposed, not an install target", async () => {
  const e = env("linux", ["cli-anything-audacity"]) // harness present but sox absent
  const cat = mk1(e)
  const map = await cat.getAvailableClis(e.env)
  assert.equal(map["cli-anything-audacity"]!.available, false)
  assert.equal(map["cli-anything-audacity"]!.prereq, "missing:binary:sox")
  const targets = await cat.getInstallTargets(e.env)
  assert.equal(targets.length, 0)
})

test("platform mismatch hides the CLI", async () => {
  const e = env("linux", ["cli-anything-iterm2"])
  const map = await mk(e).getAvailableClis(e.env)
  assert.equal(map["cli-anything-iterm2"]!.prereq, "platform:linux")
  assert.equal(map["cli-anything-iterm2"]!.available, false)
})

test("service reachability gates availability", async () => {
  const up = env("linux", ["cli-anything-comfyui"])
  assert.equal(
    (await mk(up, true).getAvailableClis(up.env))["cli-anything-comfyui"]!
      .available,
    true
  )
  const down = env("linux", ["cli-anything-comfyui"])
  const m = await mk(down, false).getAvailableClis(down.env)
  assert.equal(m["cli-anything-comfyui"]!.available, false)
  assert.equal(
    m["cli-anything-comfyui"]!.prereq,
    "missing:service:http://localhost:8188"
  )
})

test("empty underlying (no prereq) → available iff harness on PATH", async () => {
  const e = env("linux", ["cli-anything-mermaid"])
  assert.equal(
    (await mk(e).getAvailableClis(e.env))["cli-anything-mermaid"]!.available,
    true
  )
  const e2 = env("linux", [])
  assert.equal(
    (await mk(e2).getAvailableClis(e2.env))["cli-anything-mermaid"]!.prereq,
    "installable"
  )
})

test("probe is memoized; invalidate re-runs", async () => {
  const e = env("linux", ["sox", "cli-anything-audacity"])
  const cat = mk(e)
  await cat.getAvailableClis(e.env)
  const after1 = e.calls()
  await cat.getAvailableClis(e.env)
  assert.equal(
    e.calls(),
    after1,
    "second call uses memo (no new resolver calls)"
  )
  cat.invalidate()
  await cat.getAvailableClis(e.env)
  assert.ok(e.calls() > after1, "invalidate forces a re-probe")
})

test("onChange/emitChange notifies listeners", () => {
  const e = env("linux", [])
  const cat = mk(e)
  let n = 0
  const off = cat.onChange(() => n++)
  cat.emitChange()
  assert.equal(n, 1)
  off()
  cat.emitChange()
  assert.equal(n, 1, "unsubscribed listener no longer fires")
})

const harness = (n: string): NormalizedCli => ({
  cliName: n,
  entryPoint: `cli-anything-${n}`,
  kind: "harness-cli",
  install: { manager: "pip", cmd: "x" },
  displayName: n,
  description: "",
  category: "",
})

test("an unreviewed overlay entry is NOT exposed (safe default), even when all prereqs present", async () => {
  const cat = createCliCatalog({
    catalog: [harness("x")],
    overlay: [
      {
        cliName: "x",
        entryPoint: "cli-anything-x",
        underlying: {},
        credential: false,
        reviewed: false,
      },
    ],
    pathResolver: () => "/usr/bin/present", // everything resolves
    probeService: async () => true,
    probeVersion: async () => null,
  })
  const e = env("linux", [])
  const map = await cat.getAvailableClis(e.env)
  assert.equal(map["cli-anything-x"]!.available, false)
  assert.equal(map["cli-anything-x"]!.prereq, "unreviewed")
})

test("binary probe is alias-aware: 'python' satisfied by python3, 'node' by nodejs", async () => {
  const cat = createCliCatalog({
    catalog: [harness("p"), harness("n")],
    overlay: [
      {
        cliName: "p",
        entryPoint: "cli-anything-p",
        underlying: { binary: ["python"] },
        credential: false,
        reviewed: true,
      },
      {
        cliName: "n",
        entryPoint: "cli-anything-n",
        underlying: { binary: ["node"] },
        credential: false,
        reviewed: true,
      },
    ],
    // only python3 + nodejs on PATH (NOT python / node), harnesses present
    pathResolver: (name) =>
      ["python3", "nodejs", "cli-anything-p", "cli-anything-n"].includes(name)
        ? `/usr/bin/${name}`
        : null,
    probeService: async () => true,
    probeVersion: async () => null,
  })
  const e = env("linux", [])
  const map = await cat.getAvailableClis(e.env)
  assert.equal(
    map["cli-anything-p"]!.available,
    true,
    "python satisfied by python3"
  )
  assert.equal(
    map["cli-anything-n"]!.available,
    true,
    "node satisfied by nodejs"
  )
})

test("a throwing probe never rejects the snapshot (fail-closed → probe-error)", async () => {
  const cat = createCliCatalog({
    catalog: [harness("s")],
    overlay: [
      {
        cliName: "s",
        entryPoint: "cli-anything-s",
        underlying: { service: [{ url: "http://localhost:9" }] },
        credential: false,
        reviewed: true,
      },
    ],
    pathResolver: () => "/usr/bin/x",
    probeService: async () => {
      throw new Error("boom")
    },
    probeVersion: async () => null,
  })
  const e = env("linux", [])
  const map = await cat.getAvailableClis(e.env) // MUST NOT reject
  assert.equal(map["cli-anything-s"]!.available, false)
  assert.equal(map["cli-anything-s"]!.prereq, "probe-error")
})

test("bundled catalog loads (smoke) and every entry is keyed by a bare entryPoint", async () => {
  const cat = createCliCatalog() // uses bundled cli-catalog.generated.json + overlay
  const e = env("linux", [])
  const map = await cat.getAvailableClis(e.env)
  assert.ok(
    cat.entries().length >= 60,
    "bundled catalog has the generated CLIs"
  )
  for (const c of cat.entries()) {
    assert.ok(
      map[c.entryPoint],
      `availableClis keyed by entryPoint ${c.entryPoint}`
    )
    assert.ok(
      !/[\\/~:]/.test(c.entryPoint),
      `entryPoint ${c.entryPoint} is a bare name`
    )
  }
})
