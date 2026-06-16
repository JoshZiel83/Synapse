import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import test from "node:test"

import { startSidecar } from "./sidecar.js"
import type { ChildProcess, spawn } from "node:child_process"

function createFakeSpawn() {
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
  child.kill = (() => {
    process.nextTick(() => {
      child.exitCode = 0
      child.emit("exit", 0, null)
    })
    return true
  }) as ChildProcess["kill"]

  const writes: string[] = []
  child.stdin.on("data", (chunk) => writes.push(chunk.toString("utf8")))

  const spawnImpl = (() => child) as unknown as typeof spawn
  return { child, spawnImpl, writes }
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
      JSON.stringify({ jsonrpc: "2.0", id: "1", result: { pong: true } }) + "\n"
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
      JSON.stringify({ jsonrpc: "2.0", id: "1", error: "boom" }) + "\n"
    )
    fake.child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        error: { code: -32010, message: "boom", data: { reason: "test" } },
      }) + "\n"
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
