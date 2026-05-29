import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createPathResolver,
  defaultPathResolver,
  detectTerminalEnvironment,
} from "./environment.js"
import type { FileProbe } from "./environment.js"
import type { PathResolver, TerminalPlatform } from "./types.js"

function makeTmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Mock probe that says "yes" to a specific set of absolute paths. */
function makeProbe(present: ReadonlySet<string>): FileProbe {
  return {
    isExecutable(fullPath: string, _platform: TerminalPlatform) {
      return present.has(fullPath)
    },
  }
}

test("defaultPathResolver POSIX: skips empty/relative entries, hits absolute", () => {
  const dir = makeTmp("synapse-pathresolve-")
  try {
    const bin = join(dir, "git")
    writeFileSync(bin, "#!/bin/sh\necho ok\n")
    chmodSync(bin, 0o755)

    const env = { PATH: `:.:relative/bin:${dir}` }
    const hit = defaultPathResolver("git", env, "linux")
    assert.equal(hit, bin)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("defaultPathResolver POSIX: returns null if not on PATH (cwd hijack ignored)", () => {
  // Even if "." would resolve to cwd, resolver skips relative entries.
  const env = { PATH: "." }
  const hit = defaultPathResolver("there-is-no-such-binary-xyz", env, "linux")
  assert.equal(hit, null)
})

test("defaultPathResolver POSIX: respects POSIX exec bit", () => {
  const dir = makeTmp("synapse-execbit-")
  try {
    const bin = join(dir, "noexec")
    writeFileSync(bin, "#!/bin/sh\necho ok\n")
    chmodSync(bin, 0o644)
    const env = { PATH: dir }
    assert.equal(defaultPathResolver("noexec", env, "linux"), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("defaultPathResolver Windows: skips relative entries, joins PATHEXT", () => {
  const expectedHit = "C:\\bin\\git.exe"
  const resolver = createPathResolver(makeProbe(new Set([expectedHit])))
  const env = {
    Path: ";.\\local;C:\\bin",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
  }
  assert.equal(resolver("git", env, "win32"), expectedHit)
})

test("defaultPathResolver Windows: rejects .BAT/.CMD/.PS1 explicit extension", () => {
  // Probe says git.bat exists but resolver should still reject it.
  const resolver = createPathResolver(makeProbe(new Set(["C:\\bin\\git.bat"])))
  const env = { Path: "C:\\bin", PATHEXT: ".BAT;.CMD;.EXE" }
  // Caller asks for "git.bat" explicitly — rejected by allow-list.
  assert.equal(resolver("git.bat", env, "win32"), null)
  // Caller asks for bare "git" — only .EXE/.COM tried, none exists.
  assert.equal(resolver("git", env, "win32"), null)
})

test("defaultPathResolver Windows: bare name does not get .EXE.EXE doubled", () => {
  const resolver = createPathResolver(
    makeProbe(new Set(["C:\\Windows\\powershell.exe"]))
  )
  const env = { Path: "C:\\Windows", PATHEXT: ".EXE" }
  // Caller passes name WITH .exe → resolver must check name as-is, not
  // append another .EXE producing powershell.exe.EXE.
  assert.equal(
    resolver("powershell.exe", env, "win32"),
    "C:\\Windows\\powershell.exe"
  )
})

test("defaultPathResolver Windows: skips empty entries", () => {
  const resolver = createPathResolver(makeProbe(new Set(["C:\\bin\\git.exe"])))
  // Path with empty segments (`;;`) and relative segments.
  const env = { Path: ";;.\\bin;C:\\bin", PATHEXT: ".EXE" }
  assert.equal(resolver("git", env, "win32"), "C:\\bin\\git.exe")
})

test("detectTerminalEnvironment: mock resolver wires through to probes", async () => {
  const calls: string[] = []
  const resolver: PathResolver = (name) => {
    calls.push(name)
    return name === "git" ? "/mock/git" : null
  }
  const env = await detectTerminalEnvironment({
    platform: "linux",
    osEnv: { PATH: "/usr/bin", LANG: "en_US.UTF-8" },
    pathResolver: resolver,
  })
  assert.equal(env.platform, "linux")
  assert.equal(env.probes.git, "/mock/git")
  assert.equal(env.probes.python, null)
  assert.equal(env.probes.node, null)
  assert.equal(env.locale.utf8, true)
  // On linux we look up bash too.
  assert.ok(calls.includes("bash"))
  assert.ok(calls.includes("git"))
})

test("detectTerminalEnvironment: win32 prefers pwsh over powershell.exe", async () => {
  const calls: string[] = []
  const resolver: PathResolver = (name) => {
    calls.push(name)
    if (name === "pwsh") return "C:\\Program Files\\pwsh.exe"
    if (name === "powershell") return "C:\\Windows\\powershell.exe"
    return null
  }
  const env = await detectTerminalEnvironment({
    platform: "win32",
    osEnv: { Path: "C:\\Windows" },
    pathResolver: resolver,
  })
  assert.equal(env.powershell, "C:\\Program Files\\pwsh.exe")
  assert.equal(env.bash, null)
})

test("detectTerminalEnvironment: locale.utf8=false when no UTF-8 markers", async () => {
  const env = await detectTerminalEnvironment({
    platform: "linux",
    osEnv: { LANG: "C", LC_CTYPE: "POSIX" },
    pathResolver: () => null,
  })
  assert.equal(env.locale.utf8, false)
})
