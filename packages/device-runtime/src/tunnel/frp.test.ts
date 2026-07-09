// Regression test for Issue WWW: stop() / rotateToken() must verify
// the supplied TunnelHandle is the CURRENT managed entry. If a caller
// retains an old TunnelHandle after a restart and then calls
// stop(oldHandle), the previous implementation would look up the entry
// by runtimeServiceId alone and SIGTERM the live tunnel — silently
// breaking a healthy connection. Same risk for rotateToken(oldHandle).
//
// The assertions look at the stub's own signal log (the stub appends
// SIGTERM/SIGHUP receipts to a file the test can read) AND at the
// config file the adapter writes — checking "no crash" wasn't enough
// because ChildProcess.kill() returns a boolean rather than throwing
// when the target is already dead.

import test from "node:test"
import assert from "node:assert/strict"
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createFrpTunnelAdapter } from "./frp.js"
import type { TunnelHandle } from "@synapse/device-protocol"

/**
 * Spawn-time stub:
 *   - Writes its argv (which contains the adapter-supplied `-c <configPath>`)
 *     plus its own PID to STUB_LOG so the test can recover the configPath
 *     the adapter chose for THIS spawn.
 *   - Appends "SIGHUP" / "SIGTERM" to STUB_LOG when those signals
 *     arrive, and exits 0 on SIGTERM so node:test doesn't hang waiting
 *     for an orphan child.
 *   - Stays alive past the readiness probe via setInterval.
 */
function writeStubBinary(logPath: string): {
  binPath: string
  cleanup: () => void
} {
  const dir = mkdtempSync(join(tmpdir(), "frpc-stub-"))
  const binPath = join(dir, "frpc-stub.mjs")
  const src = [
    "#!/usr/bin/env node",
    'import { appendFileSync } from "node:fs"',
    `const logPath = ${JSON.stringify(logPath)}`,
    // argv[0]=node, argv[1]=script, argv[2]="-c", argv[3]=configPath
    'const configPath = process.argv[3] ?? ""',
    "appendFileSync(logPath, `START ${process.pid} ${configPath}\\n`)",
    'process.on("SIGHUP", () => {',
    "  appendFileSync(logPath, `SIGHUP ${process.pid}\\n`)",
    "})",
    'process.on("SIGTERM", () => {',
    "  appendFileSync(logPath, `SIGTERM ${process.pid}\\n`)",
    "  process.exit(0)",
    "})",
    "setInterval(() => {}, 60000)",
    "",
  ].join("\n")
  writeFileSync(binPath, src, { mode: 0o755 })
  chmodSync(binPath, 0o755)
  return {
    binPath,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    },
  }
}

function readSignalLog(logPath: string): {
  configPath: string | null
  sigterms: number
  sighups: number
  pid: number | null
} {
  if (!existsSync(logPath)) {
    return { configPath: null, sigterms: 0, sighups: 0, pid: null }
  }
  const raw = readFileSync(logPath, "utf-8")
  const lines = raw.split("\n").filter(Boolean)
  let configPath: string | null = null
  let pid: number | null = null
  let sigterms = 0
  let sighups = 0
  for (const line of lines) {
    if (line.startsWith("START ")) {
      // "START <pid> <configPath>"
      const [, pidStr, ...rest] = line.split(" ")
      pid = pidStr ? Number(pidStr) : null
      configPath = rest.join(" ") || null
    } else if (line.startsWith("SIGTERM")) {
      sigterms += 1
    } else if (line.startsWith("SIGHUP")) {
      sighups += 1
    }
  }
  return { configPath, sigterms, sighups, pid }
}

const STUB_SETTLE_MS = 500

test("stop() with a stale-shape handle does NOT signal the live tunnel", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frp-stop-log-"))
  const logPath = join(dir, "stub.log")
  const stub = writeStubBinary(logPath)
  try {
    const adapter = createFrpTunnelAdapter({
      frpcPath: stub.binPath,
      serverAddr: "127.0.0.1",
      serverPort: 7000,
      authToken: "test-auth",
      vhostHost: "test.local",
      startupGraceMs: 200,
    })
    const handle = await adapter.start({
      runtimeServiceId: "svc-stale-stop",
      localPort: 14001,
      registrationToken: "tok-live",
    })

    // Construct a separate handle pointing at the same service id (the
    // typical "I cached an old handle" scenario after a restart).
    const staleHandle: TunnelHandle = {
      runtimeServiceId: "svc-stale-stop",
      internalUrl: "http://stale-tunnel-edge:8080/d/orphan",
    }
    assert.notStrictEqual(staleHandle, handle)

    // Under the old bug, this would SIGTERM the live frpc. Assert the
    // signal log records ZERO SIGTERMs after the stale call.
    await adapter.stop(staleHandle)
    await new Promise((resolve) => setTimeout(resolve, STUB_SETTLE_MS))
    let log = readSignalLog(logPath)
    assert.equal(
      log.sigterms,
      0,
      "stale stop() must NOT signal the live tunnel — signal log should be empty"
    )
    assert.equal(log.sighups, 0, "stale stop() must NOT send SIGHUP either")

    // Live stop() MUST take the tunnel down for real — exactly one
    // SIGTERM should land on the still-running stub.
    await adapter.stop(handle)
    await new Promise((resolve) => setTimeout(resolve, STUB_SETTLE_MS))
    log = readSignalLog(logPath)
    assert.equal(
      log.sigterms,
      1,
      "live stop() must deliver exactly one SIGTERM to the stub"
    )
  } finally {
    stub.cleanup()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

test("rotateToken() with a stale-shape handle does NOT signal or rewrite the live config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frp-rotate-log-"))
  const logPath = join(dir, "stub.log")
  const stub = writeStubBinary(logPath)
  try {
    const adapter = createFrpTunnelAdapter({
      frpcPath: stub.binPath,
      serverAddr: "127.0.0.1",
      serverPort: 7000,
      authToken: "test-auth",
      vhostHost: "test.local",
      startupGraceMs: 200,
    })
    const handle = await adapter.start({
      runtimeServiceId: "svc-stale-rotate",
      localPort: 14002,
      registrationToken: "tok-original",
    })

    // Wait for the stub's START line so we can recover the configPath
    // the adapter wrote for THIS spawn.
    await new Promise((resolve) => setTimeout(resolve, STUB_SETTLE_MS))
    const startedLog = readSignalLog(logPath)
    assert.ok(
      startedLog.configPath && existsSync(startedLog.configPath),
      "stub must have recorded the adapter-supplied configPath"
    )
    const liveConfigPath = startedLog.configPath as string
    const originalConfig = readFileSync(liveConfigPath, "utf-8")
    assert.match(
      originalConfig,
      /tok-original/,
      "pre-condition: live config encodes the original token"
    )

    const staleHandle: TunnelHandle = {
      runtimeServiceId: "svc-stale-rotate",
      internalUrl: "http://stale-tunnel-edge:8080/d/orphan",
    }

    // The under-test call. Under the old bug, this would rewrite the
    // live config with "should-not-land" AND SIGHUP the live frpc.
    await adapter.rotateToken(staleHandle, "should-not-land")
    await new Promise((resolve) => setTimeout(resolve, STUB_SETTLE_MS))

    const postStaleConfig = readFileSync(liveConfigPath, "utf-8")
    assert.doesNotMatch(
      postStaleConfig,
      /should-not-land/,
      "stale rotateToken() must NOT rewrite the live config"
    )
    assert.match(
      postStaleConfig,
      /tok-original/,
      "live config must still encode the original token after stale rotate"
    )
    let log = readSignalLog(logPath)
    assert.equal(
      log.sighups,
      0,
      "stale rotateToken() must NOT send SIGHUP to the live tunnel"
    )

    // Live rotateToken must actually rewrite the config + SIGHUP exactly once.
    await adapter.rotateToken(handle, "tok-rotated")
    await new Promise((resolve) => setTimeout(resolve, STUB_SETTLE_MS))
    const postLiveConfig = readFileSync(liveConfigPath, "utf-8")
    assert.match(
      postLiveConfig,
      /tok-rotated/,
      "live rotateToken() must rewrite the config with the new token"
    )
    log = readSignalLog(logPath)
    assert.equal(
      log.sighups,
      1,
      "live rotateToken() must SIGHUP the stub exactly once"
    )

    // Tear the live tunnel down so the test process doesn't leak the child.
    await adapter.stop(handle)
    await new Promise((resolve) => setTimeout(resolve, STUB_SETTLE_MS))
  } finally {
    stub.cleanup()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

// Positive-path smoke: start/rotateToken/stop on the same handle must
// still work — verified via the signal log (one SIGHUP + one SIGTERM).
test("happy path: start/rotateToken/stop on the same handle delivers SIGHUP + SIGTERM exactly once each", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frp-happy-log-"))
  const logPath = join(dir, "stub.log")
  const stub = writeStubBinary(logPath)
  try {
    const adapter = createFrpTunnelAdapter({
      frpcPath: stub.binPath,
      serverAddr: "127.0.0.1",
      serverPort: 7000,
      authToken: "test-auth",
      vhostHost: "test.local",
      startupGraceMs: 200,
    })
    const handle = await adapter.start({
      runtimeServiceId: "svc-happy",
      localPort: 14003,
      registrationToken: "tok-a",
    })
    // Wait for the stub to actually register its SIGHUP handler before
    // rotateToken fires the signal — otherwise Node's default SIGHUP
    // disposition (terminate) can swallow it before our handler attaches.
    await new Promise((resolve) => setTimeout(resolve, STUB_SETTLE_MS))
    await adapter.rotateToken(handle, "tok-b")
    await new Promise((resolve) => setTimeout(resolve, STUB_SETTLE_MS))
    await adapter.stop(handle)
    await new Promise((resolve) => setTimeout(resolve, STUB_SETTLE_MS))
    const log = readSignalLog(logPath)
    const dump = existsSync(logPath)
      ? readFileSync(logPath, "utf-8")
      : "(no log)"
    assert.equal(log.sighups, 1, `exactly one SIGHUP — log:\n${dump}`)
    assert.equal(log.sigterms, 1, `exactly one SIGTERM — log:\n${dump}`)
  } finally {
    stub.cleanup()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

// ── R4 #3: internalUrl is configurable (was hardcoded http://tunnel-edge:8080).

test("frp start(): internalUrl defaults to http://tunnel-edge:8080/d/<token>", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frp-url-default-"))
  const logPath = join(dir, "stub.log")
  const stub = writeStubBinary(logPath)
  try {
    const adapter = createFrpTunnelAdapter({
      frpcPath: stub.binPath,
      serverAddr: "127.0.0.1",
      serverPort: 7000,
      authToken: "t",
      vhostHost: "tunnel-edge",
      startupGraceMs: 200,
    })
    const handle = await adapter.start({
      runtimeServiceId: "svc-url-1",
      localPort: 14010,
      registrationToken: "tok-default",
    })
    assert.equal(
      handle.internalUrl,
      "http://tunnel-edge:8080/d/tok-default",
      "default internal base preserved"
    )
    await adapter.stop(handle)
    await new Promise((resolve) => setTimeout(resolve, STUB_SETTLE_MS))
  } finally {
    stub.cleanup()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

test("frp start(): internalBaseUrl override is honored (custom edge) + trailing slash trimmed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frp-url-custom-"))
  const logPath = join(dir, "stub.log")
  const stub = writeStubBinary(logPath)
  try {
    const adapter = createFrpTunnelAdapter({
      frpcPath: stub.binPath,
      serverAddr: "127.0.0.1",
      serverPort: 7000,
      authToken: "t",
      vhostHost: "edge.example.com",
      internalBaseUrl: "https://edge.example.com:9443/",
      startupGraceMs: 200,
    })
    const handle = await adapter.start({
      runtimeServiceId: "svc-url-2",
      localPort: 14011,
      registrationToken: "tok-custom",
    })
    assert.equal(
      handle.internalUrl,
      "https://edge.example.com:9443/d/tok-custom",
      "custom base used + single /d/ join (no double slash)"
    )
    await adapter.stop(handle)
    await new Promise((resolve) => setTimeout(resolve, STUB_SETTLE_MS))
  } finally {
    stub.cleanup()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})
