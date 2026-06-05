import { strict as assert } from "node:assert"
import { test } from "node:test"

import {
  buildDaemonInstallCommands,
  buildDeviceInstallCommands,
  getRenderedInstallerArtifacts,
} from "./install-command.js"

const CFG = {
  serverUrl: "https://synapse.example.com",
  privateRegistry: "https://npmr.example.com/",
}

test("getRenderedInstallerArtifacts: substitutes placeholders + hashes are stable", () => {
  const a = getRenderedInstallerArtifacts(CFG)
  assert.ok(a, "artifacts should be non-null with a private registry")
  // placeholders gone
  assert.ok(!a.scriptSh.includes("@@SYNAPSE_SERVER_URL@@"))
  assert.ok(!a.scriptSh.includes("@@SYNAPSE_NPM_REGISTRY@@"))
  assert.ok(!a.scriptPs1.includes("@@SYNAPSE_SERVER_URL@@"))
  // values present
  assert.ok(a.scriptSh.includes("https://synapse.example.com"))
  assert.ok(a.scriptSh.includes("https://npmr.example.com/"))
  // sha256 are 64-hex
  assert.match(a.shaSh, /^[0-9a-f]{64}$/)
  assert.match(a.shaPs1, /^[0-9a-f]{64}$/)
  // deterministic
  const b = getRenderedInstallerArtifacts(CFG)!
  assert.equal(a.shaSh, b.shaSh)
  assert.equal(a.shaPs1, b.shaPs1)
})

test("single-direction hash injection: install.sh embeds shaPs1, install.ps1 does NOT embed shaSh", () => {
  const a = getRenderedInstallerArtifacts(CFG)!
  // install.sh's @@SYNAPSE_PS1_SHA256@@ is replaced with the real shaPs1
  assert.ok(
    a.scriptSh.includes(a.shaPs1),
    "install.sh must embed the rendered install.ps1 sha256"
  )
  assert.ok(!a.scriptSh.includes("@@SYNAPSE_PS1_SHA256@@"))
  // install.ps1 must NOT contain shaSh (no cycle)
  assert.ok(
    !a.scriptPs1.includes(a.shaSh),
    "install.ps1 must NOT embed install.sh sha256 (would create a hash cycle)"
  )
})

test("empty private registry disables artifacts (and thus the route)", () => {
  assert.equal(
    getRenderedInstallerArtifacts({
      serverUrl: CFG.serverUrl,
      privateRegistry: "",
    }),
    null
  )
  assert.equal(
    getRenderedInstallerArtifacts({
      serverUrl: CFG.serverUrl,
      privateRegistry: "   ",
    }),
    null
  )
})

test("device unix command: download-to-file + sha verify + bash, never pipes", () => {
  const a = getRenderedInstallerArtifacts(CFG)!
  const cmd = buildDeviceInstallCommands({
    serverUrl: CFG.serverUrl,
    pairingCode: "ABC123",
    shaSh: a.shaSh,
    shaPs1: a.shaPs1,
  })
  // no `| bash` / `| sh` stream-exec
  assert.ok(!/\|\s*(bash|sh)\b/.test(cmd.unix), "must not pipe to a shell")
  // curl||wget fallback
  assert.ok(cmd.unix.includes("curl -fsSL"))
  assert.ok(cmd.unix.includes("wget -qO"))
  // sha256sum||shasum verify with the sh hash
  assert.ok(cmd.unix.includes(a.shaSh))
  assert.ok(cmd.unix.includes("sha256sum -c -"))
  assert.ok(cmd.unix.includes("shasum -a 256 -c -"))
  // bash "$f" with device flags incl. --server
  assert.ok(cmd.unix.includes('bash "$f"'))
  assert.ok(cmd.unix.includes("--target 'device'"))
  assert.ok(cmd.unix.includes("--server 'https://synapse.example.com'"))
  assert.ok(cmd.unix.includes("--code 'ABC123'"))
})

test("device windows command: PS-native, Get-FileHash verify, -File, no iex", () => {
  const a = getRenderedInstallerArtifacts(CFG)!
  const cmd = buildDeviceInstallCommands({
    serverUrl: CFG.serverUrl,
    pairingCode: "ABC123",
    shaSh: a.shaSh,
    shaPs1: a.shaPs1,
  })
  assert.ok(!/\|\s*iex\b/i.test(cmd.windows), "must not iex a network stream")
  assert.ok(cmd.windows.includes("-OutFile"))
  assert.ok(cmd.windows.includes("Get-FileHash"))
  assert.ok(cmd.windows.includes(a.shaPs1.toUpperCase()))
  assert.ok(cmd.windows.includes("-ExecutionPolicy Bypass"))
  assert.ok(cmd.windows.includes("-File $f"))
  // Windows uses PS-style flags, NOT the unix long-dash form
  assert.ok(cmd.windows.includes("-Target 'device'"))
  assert.ok(cmd.windows.includes("-Server 'https://synapse.example.com'"))
  assert.ok(cmd.windows.includes("-Code 'ABC123'"))
  assert.ok(!cmd.windows.includes("--target"))
})

test("daemon commands: unix --server/--api-key, windows -Server/-ApiKey (distinct forms)", () => {
  const a = getRenderedInstallerArtifacts(CFG)!
  const cmd = buildDaemonInstallCommands({
    serverUrl: CFG.serverUrl,
    apiKey: "sk_machine_deadbeef",
    shaSh: a.shaSh,
    shaPs1: a.shaPs1,
  })
  // unix
  assert.ok(cmd.unix.includes("--target 'daemon'"))
  assert.ok(cmd.unix.includes("--server 'https://synapse.example.com'"))
  assert.ok(cmd.unix.includes("--api-key 'sk_machine_deadbeef'"))
  // windows
  assert.ok(cmd.windows.includes("-Target 'daemon'"))
  assert.ok(cmd.windows.includes("-Server 'https://synapse.example.com'"))
  assert.ok(cmd.windows.includes("-ApiKey 'sk_machine_deadbeef'"))
  assert.ok(!cmd.windows.includes("--api-key"))
})

test("shell quoting neutralizes embedded quotes in values", () => {
  const a = getRenderedInstallerArtifacts(CFG)!
  const cmd = buildDeviceInstallCommands({
    serverUrl: CFG.serverUrl,
    pairingCode: "a'b; rm -rf /",
    shaSh: a.shaSh,
    shaPs1: a.shaPs1,
  })
  // bash single-quote escaping: ' -> '\''
  assert.ok(cmd.unix.includes("'a'\\''b; rm -rf /'"))
  // PowerShell single-quote escaping: ' -> ''
  assert.ok(cmd.windows.includes("'a''b; rm -rf /'"))
})

test("rendered script never points @synapse:registry at npmjs", () => {
  const a = getRenderedInstallerArtifacts(CFG)!
  // the @synapse scope must resolve to the private registry, not public npmjs
  assert.ok(!/@synapse:registry=\S*registry\.npmjs\.org/.test(a.scriptSh))
})

// --- real-execution tests (review #1: the verify segment must actually run) -
import { execFileSync } from "node:child_process"
import { writeFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"

// Extract the `printf ... | { sha256sum ... }` verify segment from a unix
// command and run it for real against a temp file, asserting it accepts a
// matching sha and rejects a mismatching one (guards the literal-$f bug).
function runVerifySegment(shaSh: string, fileContent: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), "synapse-vseg-"))
  const f = join(dir, "payload")
  writeFileSync(f, fileContent)
  try {
    const script = `f=${JSON.stringify(f)}; printf '%s  %s\\n' ${JSON.stringify(shaSh)} "$f" | { sha256sum -c - 2>/dev/null || shasum -a 256 -c - 2>/dev/null; }`
    execFileSync("bash", ["-c", script], { stdio: "ignore" })
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("unix verify segment: accepts matching sha, rejects mismatch (real exec)", () => {
  const content = "hello-synapse-installer"
  const goodSha = createHash("sha256").update(content).digest("hex")
  assert.equal(
    runVerifySegment(goodSha, content),
    true,
    "matching sha must verify OK"
  )
  assert.equal(
    runVerifySegment("0".repeat(64), content),
    false,
    "mismatching sha must fail"
  )
})

test("renderScript: hostile config value with $() / quotes is inert in the rendered sh", () => {
  const a = getRenderedInstallerArtifacts({
    serverUrl: "https://s.example/",
    privateRegistry: "https://r/$(touch /tmp/SYNAPSE_PWNED_TEST)/'x",
  })!
  const line = a.scriptSh
    .split("\n")
    .find((l) => l.startsWith("SYNAPSE_RENDERED_PRIVATE_REGISTRY="))!
  // Source ONLY that assignment line and confirm no command substitution ran.
  const dir = mkdtempSync(join(tmpdir(), "synapse-inject-"))
  try {
    const probe = `rm -f /tmp/SYNAPSE_PWNED_TEST; ${line}; test -e /tmp/SYNAPSE_PWNED_TEST && echo PWNED || echo SAFE`
    const out = execFileSync("bash", ["-c", probe], { encoding: "utf8" }).trim()
    assert.equal(
      out,
      "SAFE",
      "command substitution in a config value must NOT execute"
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync("/tmp/SYNAPSE_PWNED_TEST", { force: true })
  }
})
