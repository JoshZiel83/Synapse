import { test } from "node:test"
import assert from "node:assert/strict"

import { detectTerminalEnvironment } from "./environment.js"
import {
  buildExecFileDescriptor,
  decodePowerShellCommand,
  encodePowerShellCommand,
  PosixBashProvider,
  POWERSHELL_PROLOGUE,
  PowerShellProvider,
  ShellNotAvailableError,
} from "./shell-provider.js"
import type { ResolvedToolchain } from "./types.js"

test("PosixBashProvider: spawn descriptor uses absolute bash path + bash -c", async () => {
  const env = await detectTerminalEnvironment({
    platform: "linux",
    osEnv: { PATH: "/usr/bin" },
    pathResolver: (name) => (name === "bash" ? "/usr/local/bin/bash" : null),
  })
  const provider = PosixBashProvider.fromEnvironment(env)!
  assert.ok(provider)
  const desc = provider.buildShellDescriptor({
    kind: "shell",
    executor: "bash",
    command: "echo hi",
  })
  assert.equal(desc.program, "/usr/local/bin/bash")
  assert.deepEqual(desc.args, ["-c", "echo hi"])
  // Regression: NOT bash -lc, NOT literal "bash".
  assert.ok(!desc.args.includes("-lc"))
  assert.notEqual(desc.program, "bash")
})

test("PosixBashProvider: unavailable when env.bash is null", async () => {
  const env = await detectTerminalEnvironment({
    platform: "linux",
    osEnv: {},
    pathResolver: () => null,
  })
  assert.equal(PosixBashProvider.fromEnvironment(env), null)
})

test("PowerShellProvider: uses -EncodedCommand with UTF-16LE base64", async () => {
  const env = await detectTerminalEnvironment({
    platform: "win32",
    osEnv: { Path: "C:\\Windows" },
    pathResolver: (name) =>
      name === "pwsh" ? "C:\\Program Files\\PowerShell\\7\\pwsh.exe" : null,
  })
  const provider = PowerShellProvider.fromEnvironment(env)!
  assert.ok(provider)
  const desc = provider.buildShellDescriptor({
    kind: "shell",
    executor: "powershell",
    command: "Write-Output '你好'",
  })
  assert.equal(desc.program, "C:\\Program Files\\PowerShell\\7\\pwsh.exe")
  // [NoProfile, NonInteractive, EncodedCommand, <base64>]
  assert.equal(desc.args.length, 4)
  assert.equal(desc.args[0], "-NoProfile")
  assert.equal(desc.args[1], "-NonInteractive")
  assert.equal(desc.args[2], "-EncodedCommand")
  const decoded = decodePowerShellCommand(desc.args[3])
  assert.ok(decoded.startsWith(POWERSHELL_PROLOGUE))
  assert.ok(decoded.includes("Write-Output '你好'"))
})

test("encodePowerShellCommand: round-trip", () => {
  const cmd = "Get-ChildItem 'C:\\Users\\张三'"
  const encoded = encodePowerShellCommand(cmd)
  const decoded = decodePowerShellCommand(encoded)
  assert.equal(decoded, POWERSHELL_PROLOGUE + cmd)
})

test("PowerShellProvider: throws when called with wrong executor", async () => {
  const env = await detectTerminalEnvironment({
    platform: "win32",
    osEnv: { Path: "C:\\Windows" },
    pathResolver: (name) =>
      name === "pwsh" ? "C:\\Program Files\\PowerShell\\7\\pwsh.exe" : null,
  })
  const provider = PowerShellProvider.fromEnvironment(env)!
  assert.throws(() =>
    provider.buildShellDescriptor({
      kind: "shell",
      executor: "bash" as unknown as "powershell",
      command: "echo hi",
    })
  )
})

test("buildExecFileDescriptor: passes resolved binPath, NEVER req.program", () => {
  const resolved: ResolvedToolchain = {
    source: "system",
    name: "git",
    binPath: "/usr/local/bin/git",
    binDir: "/usr/local/bin",
    env: {},
  }
  const desc = buildExecFileDescriptor(
    {
      kind: "exec_file",
      program: "git",
      args: ["status", "--short"],
    },
    resolved
  )
  assert.equal(desc.program, "/usr/local/bin/git")
  assert.deepEqual(desc.args, ["status", "--short"])
  // Regression: descriptor.stdio matches contract.
  assert.deepEqual(desc.stdio, ["ignore", "pipe", "pipe"])
})

test("buildExecFileDescriptor: uses bundled binPath when resolved is bundled", () => {
  const resolved: ResolvedToolchain = {
    source: "bundled-archive",
    name: "git",
    version: "2.43.0",
    rootDir: "/opt/tc/git-2.43.0",
    binPath: "/opt/tc/git-2.43.0/bin/git",
    binDir: "/opt/tc/git-2.43.0/bin",
    env: { GIT_EXEC_PATH: "/opt/tc/git-2.43.0/libexec/git-core" },
    requiredFiles: ["bin/git"],
  }
  const desc = buildExecFileDescriptor(
    { kind: "exec_file", program: "git", args: ["--version"] },
    resolved
  )
  assert.equal(desc.program, "/opt/tc/git-2.43.0/bin/git")
})

test("ShellNotAvailableError: carries executor identity", () => {
  const err = new ShellNotAvailableError("bash")
  assert.equal(err.executor, "bash")
  assert.match(err.message, /bash/)
})
