import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"

import { createFsHelperClient } from "./fs-helper-client.js"
import type { SidecarHandle } from "../sidecar.js"

type SpawnLike = (typeof import("node:child_process"))["spawn"]

interface FakeChild {
  handle: SidecarHandle
  emitExit(code: number | null): void
  resolveRequest(method: string, result: unknown): void
  startCount: number
}

function makeFakeStart(): {
  start: (typeof import("../sidecar.js"))["startSidecar"]
  children: FakeChild[]
} {
  const children: FakeChild[] = []
  const start: (typeof import("../sidecar.js"))["startSidecar"] = () => {
    const ee = new EventEmitter() as SidecarHandle & {
      _pending: Map<
        string,
        {
          resolve: (v: unknown) => void
          reject: (e: Error) => void
          method: string
        }
      >
    }
    const pending = new Map<
      string,
      {
        resolve: (v: unknown) => void
        reject: (e: Error) => void
        method: string
      }
    >()
    ee._pending = pending
    let nextId = 0
    const handle = ee as unknown as SidecarHandle
    ;(
      handle as unknown as {
        request: (m: string, p?: unknown) => Promise<unknown>
      }
    ).request = (method: string) => {
      return new Promise((resolve, reject) => {
        const id = String(++nextId)
        pending.set(id, { resolve, reject, method })
      })
    }
    ;(
      handle as unknown as { notify: (m: string, p?: unknown) => void }
    ).notify = () => {}
    ;(handle as unknown as { stop: () => Promise<void> }).stop = async () => {
      ee.emit("exit", 0)
    }
    const child: FakeChild = {
      handle,
      startCount: 0,
      emitExit(code: number | null) {
        for (const [, p] of pending) {
          p.reject(new Error(`sidecar exited (code=${code ?? "null"})`))
        }
        pending.clear()
        ee.emit("exit", code)
      },
      resolveRequest(method: string, result: unknown) {
        for (const [id, entry] of pending) {
          if (entry.method === method) {
            pending.delete(id)
            entry.resolve(result)
            return
          }
        }
      },
    }
    children.push(child)
    child.startCount = children.length
    return handle
  }
  return {
    start: start as unknown as (typeof import("../sidecar.js"))["startSidecar"],
    children,
  }
}

function makeClient(start: ReturnType<typeof makeFakeStart>["start"]) {
  return createFsHelperClient({
    helperPath: "/usr/bin/true",
    rootPath: "/tmp/synapse-test-root",
    workDir: "/tmp/synapse-test-work",
    maxSnapshotBytes: 1,
    maxExtractBytes: 1,
    maxDiffSourceBytes: 1,
    maxDiffOutputBytes: 1,
    maxSearchLimit: 200,
    maxHistoryListLimit: 200,
    maxOffset: 10_000,
    maxHistoryBytes: 1,
    maxVersionsPerPath: 100,
    keepRecentVersions: 5,
    defaultRpcTimeoutMs: 50,
    startSidecarImpl: start,
    logger: { warn: () => {}, error: () => {} },
  })
}

test("FsHelperClient surfaces helper_timeout when sidecar never responds", async () => {
  const fake = makeFakeStart()
  const client = makeClient(fake.start)
  const startedAt = Date.now()
  await assert.rejects(
    client.historyList({ path: "/x" }),
    (e: unknown) => (e as Error).name === "FsHelperTimeoutError"
  )
  const elapsed = Date.now() - startedAt
  // Should fire close to the 50ms timeout, certainly under 1s.
  assert.ok(elapsed < 1000, `elapsed=${elapsed}ms`)
})

test("FsHelperClient restarts once after unexpected exit", async () => {
  const fake = makeFakeStart()
  const client = makeClient(fake.start)
  // Fire a request, then have the child crash before responding.
  const p1 = client.historyList({ path: "/x" })
  // wait a tick for ensureHandle to spawn
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(fake.children.length, 1)
  fake.children[0]!.emitExit(1)
  await assert.rejects(p1)
  // Next request triggers a fresh spawn.
  const p2 = client.historyList({ path: "/y" })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(fake.children.length, 2)
  // Resolve to clean up.
  fake.children[1]!.resolveRequest("fs.history.list", { entries: [] })
  await p2
})

test("FsHelperClient parks after second crash within 60s window", async () => {
  const fake = makeFakeStart()
  const client = makeClient(fake.start)
  const p1 = client.historyList({})
  await new Promise((r) => setTimeout(r, 5))
  fake.children[0]!.emitExit(1)
  await assert.rejects(p1)
  const p2 = client.historyList({})
  await new Promise((r) => setTimeout(r, 5))
  fake.children[1]!.emitExit(1)
  await assert.rejects(p2)
  // Third call must immediately fail FsHelperUnavailable (parked).
  await assert.rejects(
    client.historyList({}),
    (e: unknown) => (e as Error).name === "FsHelperUnavailableError"
  )
  assert.equal(client.isAvailable(), false)
})
