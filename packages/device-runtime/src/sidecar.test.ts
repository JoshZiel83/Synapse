import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import test from "node:test"

import { startSidecar } from "./sidecar.js"
import type { ChildProcess, spawn } from "node:child_process"

function createFakeSpawn({
  honorEof = true,
  honorSigterm = true,
}: {
  honorEof?: boolean
  honorSigterm?: boolean
} = {}) {
  const child = new EventEmitter() as ChildProcess & {
    exitCode: number | null
    stdout: PassThrough
    stderr: PassThrough
    stdin: PassThrough
  }
  child.exitCode = null
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()

  const killSignals: string[] = []
  const doExit = () => {
    if (child.exitCode !== null) return
    process.nextTick(() => {
      child.exitCode = 0
      child.emit("exit", 0, null)
    })
  }
  child.kill = ((signal?: NodeJS.Signals | number) => {
    killSignals.push(String(signal ?? "SIGTERM"))
    // SIGKILL is always fatal; SIGTERM only when the fake "handles" it.
    if (signal === "SIGKILL" || (signal === "SIGTERM" && honorSigterm)) doExit()
    return true
  }) as ChildProcess["kill"]
  // A realistic helper exits when the supervisor closes its stdin (EOF); a
  // wedged one does not (which is what forces the SIGTERM/SIGKILL escalation).
  child.stdin.on("finish", () => {
    if (honorEof) doExit()
  })

  const writes: string[] = []
  child.stdin.on("data", (chunk) => writes.push(chunk.toString("utf8")))

  const spawnImpl = (() => child) as unknown as typeof spawn
  return { child, spawnImpl, writes, killSignals }
}

test("sidecar ignores malformed response frames before a valid result", async () => {
  const fake = createFakeSpawn()
  const handle = startSidecar({
    binaryPath: "/fake/sidecar",
    spawnImpl: fake.spawnImpl,
  })
  try {
    const response = handle.request("cua.ping", { ok: true })
    assert.equal(fake.writes.length, 1)
    fake.child.stdout.write("null\n")
    fake.child.stdout.write("[]\n")
    fake.child.stdout.write('"scalar"\n')
    fake.child.stdout.write("{not-json\n")
    fake.child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: "1", result: { pong: true } })}\n`
    )
    assert.deepEqual(await response, { pong: true })
  } finally {
    await handle.stop()
  }
})

test("sidecar ignores malformed error frames before a valid JSON-RPC error", async () => {
  const fake = createFakeSpawn()
  const handle = startSidecar({
    binaryPath: "/fake/sidecar",
    spawnImpl: fake.spawnImpl,
  })
  try {
    const response = handle.request("cua.fail")
    fake.child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: "1", error: "boom" })}\n`
    )
    fake.child.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        error: { code: -32010, message: "boom", data: { reason: "test" } },
      })}\n`
    )
    await assert.rejects(response, (err: unknown) => {
      const error = err as Error & {
        jsonRpcCode?: number
        jsonRpcData?: unknown
      }
      assert.equal(error.message, "-32010: boom")
      assert.equal(error.jsonRpcCode, -32010)
      assert.deepEqual(error.jsonRpcData, { reason: "test" })
      return true
    })
  } finally {
    await handle.stop()
  }
})

// ── staged stop: EOF grace → SIGTERM → SIGKILL (F9b) ─────────────────────────
// The old stop() fired stdin.end() and kill("SIGTERM") in the same tick, so the
// helper never saw EOF and its buffered OTLP spans died with the signal. The
// staged stop gives the child an EOF grace to flush + exit on its own, and only
// escalates to SIGTERM / SIGKILL if it does not.

test("stop(): a child that honors EOF is never signalled", async () => {
  const fake = createFakeSpawn({ honorEof: true })
  const handle = startSidecar({
    binaryPath: "/fake/sidecar",
    spawnImpl: fake.spawnImpl,
    stopEofGraceMs: 500,
    stopTermGraceMs: 500,
  })
  await handle.stop()
  assert.deepEqual(
    fake.killSignals,
    [],
    "a helper that exits on stdin EOF must never receive a signal"
  )
})

test("stop(): a child that ignores EOF gets SIGTERM then SIGKILL, in order", async () => {
  // honorEof:false → never exits on stdin close; honorSigterm:false → ignores
  // SIGTERM too, forcing escalation all the way to SIGKILL.
  const fake = createFakeSpawn({ honorEof: false, honorSigterm: false })
  const handle = startSidecar({
    binaryPath: "/fake/sidecar",
    spawnImpl: fake.spawnImpl,
    stopEofGraceMs: 20,
    stopTermGraceMs: 20,
  })
  await handle.stop()
  assert.deepEqual(
    fake.killSignals,
    ["SIGTERM", "SIGKILL"],
    "a wedged helper must escalate EOF → SIGTERM → SIGKILL in that order"
  )
})
