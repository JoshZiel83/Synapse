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
      // The client handshakes (fs.hello) on every fresh handle before its
      // first real RPC. Auto-resolve it so tests exercise the real method's
      // behavior (timeout / restart / park) rather than hanging on the
      // unanswered handshake. Keys on method only, matching resolveRequest.
      if (method === "fs.hello") {
        return Promise.resolve({ proto_version: 2, crate_version: "test" })
      }
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

interface HelloFakeChild {
  handle: SidecarHandle
  stopped: boolean
  resolveRequest(method: string, result: unknown): void
}

/**
 * Fake start whose fs.hello answer varies per spawn — drives the
 * handshake-failure-then-recovery path. `helloPerStart[i]` is the hello result
 * for the i-th spawned helper; out-of-range spawns reuse the last entry. Special
 * values: an `Error` rejects the handshake; `HELLO_HANG` never settles (to
 * exercise the handshake timeout). Records whether each handle was stop()ed so a
 * test can assert a failed-handshake handle is torn down.
 */
const HELLO_HANG = Symbol("hello-hang")

function makeHelloVaryingStart(helloPerStart: Array<unknown | Error>): {
  start: (typeof import("../sidecar.js"))["startSidecar"]
  children: HelloFakeChild[]
} {
  const children: HelloFakeChild[] = []
  const start: (typeof import("../sidecar.js"))["startSidecar"] = () => {
    const ee = new EventEmitter() as SidecarHandle
    const pending = new Map<
      string,
      {
        resolve: (v: unknown) => void
        reject: (e: Error) => void
        method: string
      }
    >()
    let nextId = 0
    const index = children.length
    const handle = ee as unknown as SidecarHandle
    const child: HelloFakeChild = {
      handle,
      stopped: false,
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
    ;(
      handle as unknown as {
        request: (m: string, p?: unknown) => Promise<unknown>
      }
    ).request = (method: string) => {
      if (method === "fs.hello") {
        const hello = helloPerStart[Math.min(index, helloPerStart.length - 1)]
        if (hello === HELLO_HANG) return new Promise<unknown>(() => {}) // never settles
        return hello instanceof Error
          ? Promise.reject(hello)
          : Promise.resolve(hello)
      }
      return new Promise((resolve, reject) => {
        const id = String(++nextId)
        pending.set(id, { resolve, reject, method })
      })
    }
    ;(
      handle as unknown as { notify: (m: string, p?: unknown) => void }
    ).notify = () => {}
    ;(handle as unknown as { stop: () => Promise<void> }).stop = async () => {
      child.stopped = true
      ee.emit("exit", 0)
    }
    children.push(child)
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

test("handshake mismatch tears down the helper; next RPC respawns and recovers", async () => {
  // First spawn reports a wrong proto_version (a stale binary). After the
  // operator rebuilds, the SECOND spawn reports the right version. The next
  // RPC must spawn a fresh helper and succeed — not keep reusing the stale
  // process.
  const fake = makeHelloVaryingStart([
    { proto_version: 999, crate_version: "stale" }, // 1st spawn: mismatch
    { proto_version: 2, crate_version: "rebuilt" }, // 2nd spawn: good
  ])
  const client = makeClient(fake.start)

  await assert.rejects(
    client.historyList({ path: "/x" }),
    (e: unknown) => (e as Error).name === "FsHelperProtoMismatchError"
  )
  // The mismatched handle was torn down (stopped + cleared), not left serving.
  assert.equal(fake.children.length, 1)
  assert.equal(fake.children[0]!.stopped, true, "stale handle must be stopped")

  // Next RPC spawns a fresh helper (simulating the rebuilt binary) and works.
  const p = client.historyList({ path: "/x" })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(fake.children.length, 2, "a fresh helper must be spawned")
  fake.children[1]!.resolveRequest("fs.history.list", { entries: [] })
  await p
})

test("repeated handshake mismatch does NOT park the client", async () => {
  // A proto mismatch is not a crash loop: tearing the handle down must not
  // count toward the crash-park window, so the operator's rebuild is always
  // picked up by the next RPC rather than hitting a parked client.
  const fake = makeHelloVaryingStart([
    { proto_version: 999, crate_version: "stale" }, // every spawn mismatches…
  ])
  const client = makeClient(fake.start)

  for (let i = 0; i < 3; i++) {
    await assert.rejects(
      client.historyList({}),
      (e: unknown) => (e as Error).name === "FsHelperProtoMismatchError"
    )
  }
  // Still available (not parked) and it kept spawning fresh helpers each time.
  assert.equal(client.isAvailable(), true)
  assert.equal(fake.children.length, 3)
})

test("repeated fs.hello timeout DOES park the client (wedge is a crash loop)", async () => {
  // A handshake that hangs (wedged helper) is NOT a stale-binary case: it must
  // count toward the crash-park window so a stuck helper can't be re-spawned
  // forever. Two timeouts within 60s → parked.
  const fake = makeHelloVaryingStart([HELLO_HANG])
  const client = makeClient(fake.start)

  await assert.rejects(
    client.historyList({}),
    (e: unknown) => (e as Error).name === "FsHelperTimeoutError"
  )
  await assert.rejects(
    client.historyList({}),
    (e: unknown) => (e as Error).name === "FsHelperTimeoutError"
  )
  // Third call must immediately fail FsHelperUnavailable (parked) — the wedge
  // was counted toward the park window, unlike a proto mismatch.
  await assert.rejects(
    client.historyList({}),
    (e: unknown) => (e as Error).name === "FsHelperUnavailableError"
  )
  assert.equal(client.isAvailable(), false)
})
