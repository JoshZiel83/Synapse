import { test } from "node:test"
import assert from "node:assert/strict"

import { detectTerminalEnvironment } from "./environment.js"
import {
  previewSpawnEnv,
  resolveTaskkillPath,
  spawnTerminalProcess,
} from "./executor.js"
import { PosixBashProvider } from "./shell-provider.js"
import { buildUtf8Env } from "./utf8.js"

const bashPath = "/bin/bash"

async function makeLinuxEnv(overrides: Record<string, string> = {}) {
  return detectTerminalEnvironment({
    platform: "linux",
    osEnv: { PATH: process.env.PATH ?? "/usr/bin", ...overrides },
    pathResolver: (name) => (name === "bash" ? bashPath : null),
  })
}

test("previewSpawnEnv: toolchain env overrides baseEnv, PATH prepended + sanitized", async () => {
  const env = await makeLinuxEnv()
  const baseEnv = buildUtf8Env(env.osEnv, {
    allowedEnv: [],
    platform: "linux",
  })
  const merged = previewSpawnEnv({
    baseEnv,
    // Mix in empty + truly relative segments to verify sanitize survives the
    // combined string.
    toolchainBinDirs: ["/opt/tc/git-1/bin", "", "relative/bin", "."],
    toolchainEnv: { GIT_EXEC_PATH: "/opt/tc/git-1/libexec/git-core" },
    platform: "linux",
    osEnv: env.osEnv,
  })
  assert.equal(merged.GIT_EXEC_PATH, "/opt/tc/git-1/libexec/git-core")
  // PATH ordering: toolchain binDir first, sanitized of empty + relative.
  const segments = merged.PATH.split(":")
  assert.equal(segments[0], "/opt/tc/git-1/bin")
  assert.ok(!segments.includes(""))
  assert.ok(!segments.includes("relative/bin"))
  assert.ok(!segments.includes("."))
})

test("spawnTerminalProcess: bash -c echo hi yields exit 0 + stdout", async () => {
  const env = await makeLinuxEnv()
  const provider = PosixBashProvider.fromEnvironment(env)
  if (!provider) {
    // Can't run on this CI host; skip without failing.
    return
  }
  const baseEnv = buildUtf8Env(env.osEnv, {
    allowedEnv: [],
    platform: "linux",
  })
  const desc = provider.buildShellDescriptor({
    kind: "shell",
    executor: "bash",
    command: "echo hi",
  })
  const result = await spawnTerminalProcess(desc, {
    baseEnv,
    toolchainBinDirs: [],
    toolchainEnv: {},
    platform: "linux",
    osEnv: env.osEnv,
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.trim(), "hi")
  assert.equal(result.killed, false)
})

test("spawnTerminalProcess: process.env.PATH is not mutated", async () => {
  const original = process.env.PATH
  const env = await makeLinuxEnv()
  const provider = PosixBashProvider.fromEnvironment(env)
  if (!provider) return
  const baseEnv = buildUtf8Env(env.osEnv, {
    allowedEnv: [],
    platform: "linux",
  })
  const desc = provider.buildShellDescriptor({
    kind: "shell",
    executor: "bash",
    command: "true",
  })
  await spawnTerminalProcess(desc, {
    baseEnv,
    toolchainBinDirs: ["/opt/fake/bin"],
    toolchainEnv: { FAKE_ENV: "1" },
    platform: "linux",
    osEnv: env.osEnv,
  })
  assert.equal(process.env.PATH, original)
  assert.equal(process.env.FAKE_ENV, undefined)
})

test("spawnTerminalProcess: child sees prepended toolchain binDir on PATH", async () => {
  const env = await makeLinuxEnv()
  const provider = PosixBashProvider.fromEnvironment(env)
  if (!provider) return
  const baseEnv = buildUtf8Env(env.osEnv, {
    allowedEnv: [],
    platform: "linux",
  })
  const desc = provider.buildShellDescriptor({
    kind: "shell",
    executor: "bash",
    command: 'printf "%s" "$PATH"',
  })
  const result = await spawnTerminalProcess(desc, {
    baseEnv,
    toolchainBinDirs: ["/opt/synapse-test-binDir"],
    toolchainEnv: {},
    platform: "linux",
    osEnv: env.osEnv,
  })
  assert.equal(result.exitCode, 0)
  assert.ok(result.stdout.startsWith("/opt/synapse-test-binDir:"))
})

test("spawnTerminalProcess: child sees Chinese stdout intact (UTF-8 end to end)", async () => {
  const env = await makeLinuxEnv()
  const provider = PosixBashProvider.fromEnvironment(env)
  if (!provider) return
  const baseEnv = buildUtf8Env(env.osEnv, {
    allowedEnv: [],
    platform: "linux",
  })
  const desc = provider.buildShellDescriptor({
    kind: "shell",
    executor: "bash",
    command: "printf '%s' '你好，世界'",
  })
  const result = await spawnTerminalProcess(desc, {
    baseEnv,
    toolchainBinDirs: [],
    toolchainEnv: {},
    platform: "linux",
    osEnv: env.osEnv,
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, "你好，世界")
  assert.ok(!result.stdout.includes("�"))
})

test("spawnTerminalProcess: timeout kills child + descendants (POSIX process group)", async () => {
  const env = await makeLinuxEnv()
  const provider = PosixBashProvider.fromEnvironment(env)
  if (!provider) return
  const baseEnv = buildUtf8Env(env.osEnv, {
    allowedEnv: [],
    platform: "linux",
  })
  // sleep is a descendant of bash here; the process group kill should reach
  // it on timeout.
  const desc = provider.buildShellDescriptor({
    kind: "shell",
    executor: "bash",
    command: "sleep 30 & wait",
  })
  const result = await spawnTerminalProcess(desc, {
    baseEnv,
    toolchainBinDirs: [],
    toolchainEnv: {},
    platform: "linux",
    osEnv: env.osEnv,
    timeoutMs: 1500,
  })
  assert.equal(result.killed, true)
  assert.ok(
    result.durationMs < 5000,
    `duration ${result.durationMs} should be short`
  )
})

test("spawnTerminalProcess: LD_PRELOAD stripped, GIT_TERMINAL_PROMPT injected", async () => {
  const env = await makeLinuxEnv()
  const provider = PosixBashProvider.fromEnvironment(env)
  if (!provider) return
  const baseEnv = buildUtf8Env(
    { ...env.osEnv, LD_PRELOAD: "/evil.so" },
    { allowedEnv: [], platform: "linux" }
  )
  const desc = provider.buildShellDescriptor({
    kind: "shell",
    executor: "bash",
    command:
      'printf "LD=%s|PROMPT=%s|PAGER=%s" "${LD_PRELOAD-}" "${GIT_TERMINAL_PROMPT-}" "${GIT_PAGER-}"',
  })
  const result = await spawnTerminalProcess(desc, {
    baseEnv,
    toolchainBinDirs: [],
    toolchainEnv: {},
    platform: "linux",
    osEnv: env.osEnv,
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, "LD=|PROMPT=0|PAGER=cat")
})

test("resolveTaskkillPath: returns null when neither path exists", () => {
  // On Linux runner, SystemRoot would be unset and C:\Windows\... never
  // exists, so this should be null.
  assert.equal(resolveTaskkillPath({ SystemRoot: "/no/such/dir" }), null)
})

test("spawnTerminalProcess: output cap kills runaway producer and reports truncation", async () => {
  const env = await makeLinuxEnv()
  const provider = PosixBashProvider.fromEnvironment(env)
  if (!provider) return
  const baseEnv = buildUtf8Env(env.osEnv, {
    allowedEnv: [],
    platform: "linux",
  })
  // `yes` would spew forever; the per-stream cap must kill it.
  const desc = provider.buildShellDescriptor({
    kind: "shell",
    executor: "bash",
    command: "yes",
  })
  const result = await spawnTerminalProcess(desc, {
    baseEnv,
    toolchainBinDirs: [],
    toolchainEnv: {},
    platform: "linux",
    osEnv: env.osEnv,
    timeoutMs: 10_000,
    maxOutputBytes: 8 * 1024, // small cap so the test finishes quickly
  })
  assert.equal(result.killed, true, "process should be killed on overflow")
  assert.equal(
    result.stdoutTruncated,
    true,
    "stdout should be flagged truncated"
  )
  assert.ok(
    (result.stdoutDroppedBytes ?? 0) > 0,
    `stdoutDroppedBytes should be >0, got ${result.stdoutDroppedBytes}`
  )
  // Kept bytes are at most the cap; the recorded output reflects only what
  // the decoder saw.
  assert.ok(
    Buffer.byteLength(result.stdout, "utf-8") <= 8 * 1024,
    `kept stdout exceeded cap: ${Buffer.byteLength(result.stdout, "utf-8")}`
  )
  assert.ok(
    result.durationMs < 7_000,
    `overflow path should be quick, got ${result.durationMs}ms`
  )
})

test("spawnTerminalProcess: well-behaved command does not set truncation flags", async () => {
  const env = await makeLinuxEnv()
  const provider = PosixBashProvider.fromEnvironment(env)
  if (!provider) return
  const baseEnv = buildUtf8Env(env.osEnv, {
    allowedEnv: [],
    platform: "linux",
  })
  const desc = provider.buildShellDescriptor({
    kind: "shell",
    executor: "bash",
    command: "echo hi",
  })
  const result = await spawnTerminalProcess(desc, {
    baseEnv,
    toolchainBinDirs: [],
    toolchainEnv: {},
    platform: "linux",
    osEnv: env.osEnv,
    maxOutputBytes: 1024,
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.killed, false)
  assert.equal(result.stdoutTruncated, false)
  assert.equal(result.stderrTruncated, false)
  assert.equal(result.stdoutDroppedBytes, 0)
  assert.equal(result.stderrDroppedBytes, 0)
})
