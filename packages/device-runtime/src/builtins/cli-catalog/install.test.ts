import test from "node:test"
import assert from "node:assert/strict"
import { createCliInstaller, buildInstallArgv } from "./install.js"
import { createCliCatalog } from "./index.js"
import type { NormalizedCli, CliPrereq } from "./index.js"
import type { ResolvedTerminalEnvironment } from "../../terminal/types.js"

const AUDACITY: NormalizedCli = {
  cliName: "audacity",
  entryPoint: "cli-anything-audacity",
  kind: "harness-cli",
  install: {
    manager: "pip",
    cmd: "pip install git+https://github.com/HKUDS/CLI-Anything.git@SHA#subdirectory=audacity/agent-harness",
  },
  displayName: "Audacity",
  description: "",
  category: "audio",
}
const AUDACITY_OVR: CliPrereq = {
  cliName: "audacity",
  entryPoint: "cli-anything-audacity",
  underlying: { binary: ["sox"] },
  credential: false,
  reviewed: true,
}

function mkEnv(): ResolvedTerminalEnvironment {
  return {
    platform: "linux",
    arch: "x64",
    osEnv: { PATH: "/usr/bin" },
    bash: "/bin/bash",
    powershell: null,
    loginShells: [],
    locale: { lang: null, lcAll: null, lcCtype: null, utf8: true },
    probes: { git: null, python: null, python3: null, node: null },
  } as unknown as ResolvedTerminalEnvironment
}

function catalogWith(present: Set<string>) {
  return createCliCatalog({
    catalog: [AUDACITY],
    overlay: [AUDACITY_OVR],
    pathResolver: (n) => (present.has(n) ? `/usr/bin/${n}` : null),
    probeService: async () => true,
    probeVersion: async () => null,
  })
}

test("installer installs a satisfiable target, flips availability, emits change", async () => {
  const present = new Set(["sox"]) // underlying present; harness NOT yet on PATH
  const cat = catalogWith(present)
  let changed = 0
  cat.onChange(() => changed++)
  const installer = createCliInstaller({
    cliCatalog: cat,
    runInstall: async (argv) => {
      assert.ok(
        argv.includes("--break-system-packages"),
        "pip uses --break-system-packages"
      )
      present.add("cli-anything-audacity") // simulate the harness landing on PATH
      return { ok: true, detail: "" }
    },
  })
  const env = mkEnv()
  const installed = await installer.runOnce(env)
  assert.deepEqual(installed, ["cli-anything-audacity"])
  assert.equal(changed, 1, "emitChange fired → runtime re-sync")
  const map = await cat.getAvailableClis(env)
  assert.equal(
    map["cli-anything-audacity"]!.available,
    true,
    "now available after install"
  )
})

test("failed install does not flip availability or emit change", async () => {
  const present = new Set(["sox"])
  const cat = catalogWith(present)
  let changed = 0
  cat.onChange(() => changed++)
  const installer = createCliInstaller({
    cliCatalog: cat,
    runInstall: async () => ({ ok: false, detail: "boom" }),
  })
  const env = mkEnv()
  const installed = await installer.runOnce(env)
  assert.deepEqual(installed, [])
  assert.equal(changed, 0)
  assert.equal(
    (await cat.getInstallTargets(env)).length,
    1,
    "still installable"
  )
})

test("nothing to install when underlying is missing (not a target)", async () => {
  const present = new Set<string>() // sox absent
  const cat = catalogWith(present)
  const installer = createCliInstaller({
    cliCatalog: cat,
    runInstall: async () => {
      throw new Error("must not be called")
    },
  })
  assert.deepEqual(await installer.runOnce(mkEnv()), [])
})

test("buildInstallArgv: pip injects --break-system-packages on the git+ target", () => {
  assert.deepEqual(buildInstallArgv(AUDACITY), [
    "pip",
    "install",
    "--break-system-packages",
    "git+https://github.com/HKUDS/CLI-Anything.git@SHA#subdirectory=audacity/agent-harness",
  ])
})

test("buildInstallArgv: npm passes the catalog cmd verbatim", () => {
  const npmCli: NormalizedCli = {
    ...AUDACITY,
    cliName: "feishu",
    entryPoint: "lark-cli",
    kind: "public-cli",
    install: { manager: "npm", cmd: "npm install -g @larksuite/cli" },
  }
  assert.deepEqual(buildInstallArgv(npmCli), [
    "npm",
    "install",
    "-g",
    "@larksuite/cli",
  ])
})
