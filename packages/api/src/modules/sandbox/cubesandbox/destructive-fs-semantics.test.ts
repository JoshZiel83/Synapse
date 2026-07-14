// cubesandbox:bare destructive-fs-semantics unit tests (R4 §3.5 / #7).
//
// envd honors NONE of the four safety booleans natively (live-proved): write
// auto-creates parents, mkdir is always recursive, move silently overwrites,
// remove deletes the whole tree. The plane must enforce each via a cheap pre-stat
// so the bare fs contract is IDENTICAL across adapters — and fail CLOSED on an
// unverifiable stale-write precondition (M1) instead of silently dropping it.
// These tests pin: (a) each boolean denies BEFORE the destructive envd call, with
// the SAME error the host bare plane raises; (b) the affordance still works when
// the boolean permits it; (c) the M1 fail-closed path.

import test from "node:test"
import assert from "node:assert/strict"
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { StaleWriteError } from "@synapse/device-runtime"
import { buildCubesandboxBareDescriptor } from "../model.js"
import { PreconditionUncheckableError } from "../data-plane.js"
import type { ConfinementCtx, ConfinementScope } from "../data-plane.js"
import { createRemoteBareDataPlane } from "./data-plane.js"
import type { RemoteEnvdTransport } from "./data-plane.js"
import {
  CubeEnvdNotFoundError,
  type ExecResult,
  type FileEntry,
} from "./types.js"

const descriptor = buildCubesandboxBareDescriptor()
const CAPS = descriptor.core
const VM_ROOT = "/workspace"

function writeCtx(scope: ConfinementScope): ConfinementCtx {
  return { scope, access: "write" }
}
const SCOPE: ConfinementScope = ["/conversation"]

const NOT_FOUND = new CubeEnvdNotFoundError("envd: not found")

/** A configurable envd stub: stat/list keyed by path; every mutating call is
 *  recorded so a test can assert the destructive op did NOT run when denied. */
class Envd implements RemoteEnvdTransport {
  readonly calls: string[] = []
  /** path → entry | "missing" (throws NotFound). Default: everything is a file. */
  statMap: Record<string, FileEntry | "missing"> = {}
  /** path → children (for the non-empty-dir remove gate). */
  listMap: Record<string, FileEntry[]> = {}
  readBytes = Buffer.from("prior-content")

  async exec(): Promise<ExecResult> {
    return { exitCode: 0, stdout: "", stderr: "" }
  }
  async stat(path: string): Promise<FileEntry> {
    const e = this.statMap[path]
    if (e === "missing") throw NOT_FOUND
    if (e) return e
    return {
      name: "f",
      path,
      type: "file",
      size: 11,
      modifiedTime: "2026-07-13T00:00:00Z",
    }
  }
  async listDir(path: string): Promise<FileEntry[]> {
    return this.listMap[path] ?? []
  }
  async makeDir(path: string): Promise<FileEntry> {
    this.calls.push(`makeDir:${path}`)
    return { name: "d", path, type: "directory" }
  }
  async move(source: string, destination: string): Promise<FileEntry> {
    this.calls.push(`move:${source}=>${destination}`)
    return { name: "m", path: destination, type: "file" }
  }
  async remove(path: string): Promise<void> {
    this.calls.push(`remove:${path}`)
  }
  async readFile(): Promise<Buffer> {
    return this.readBytes
  }
  async writeFile(path: string): Promise<FileEntry[]> {
    this.calls.push(`writeFile:${path}`)
    return []
  }
  async close(): Promise<void> {}
}

function makePlane(envd: RemoteEnvdTransport) {
  return createRemoteBareDataPlane({
    sandboxID: "sbx",
    descriptor,
    vmRoot: VM_ROOT,
    envd,
    confirmGone: async () => true,
  })
}

function dir(path: string): FileEntry {
  return { name: "d", path, type: "directory" }
}
function file(path: string, size = 11): FileEntry {
  return {
    name: "f",
    path,
    type: "file",
    size,
    modifiedTime: "2026-07-13T00:00:00Z",
  }
}

// ── fs_write create_parents ───────────────────────────────────────────────────

test("write create_parents=false + missing parent → deny, no writeFile", async () => {
  const envd = new Envd()
  envd.statMap["/workspace/conversation/sub"] = "missing"
  const plane = makePlane(envd)
  await assert.rejects(
    () =>
      plane.write(
        "/conversation/sub/f.txt",
        Buffer.from("x"),
        { createParents: false },
        writeCtx(SCOPE)
      ),
    /parent directory does not exist: \/conversation\/sub/
  )
  assert.ok(
    !envd.calls.some((c) => c.startsWith("writeFile")),
    "no write on a denied parent"
  )
})

test("write create_parents=true + missing parent → proceeds (envd auto-creates)", async () => {
  const envd = new Envd()
  envd.statMap["/workspace/conversation/sub"] = "missing"
  const plane = makePlane(envd)
  await plane.write(
    "/conversation/sub/f.txt",
    Buffer.from("x"),
    { createParents: true },
    writeCtx(SCOPE)
  )
  assert.ok(envd.calls.includes("writeFile:/workspace/conversation/sub/f.txt"))
})

// ── fs_write expected_sha256 (M1 fail-closed) ─────────────────────────────────

test("write expected_sha256 + prior too large → precondition_uncheckable, no writeFile", async () => {
  const envd = new Envd()
  envd.statMap["/workspace/conversation/f.txt"] = file(
    "/workspace/conversation/f.txt",
    CAPS.maxReadBytes + 1
  )
  const plane = makePlane(envd)
  await assert.rejects(
    () =>
      plane.write(
        "/conversation/f.txt",
        Buffer.from("x"),
        { createParents: true, expectedSha256: "deadbeef" },
        writeCtx(SCOPE)
      ),
    (err: unknown) => err instanceof PreconditionUncheckableError
  )
  assert.ok(
    !envd.calls.some((c) => c.startsWith("writeFile")),
    "fail-closed: never write when the precondition is unverifiable"
  )
})

test("write expected_sha256 mismatch (within cap) → StaleWriteError, no writeFile", async () => {
  const envd = new Envd()
  envd.statMap["/workspace/conversation/f.txt"] = file(
    "/workspace/conversation/f.txt",
    5
  )
  envd.readBytes = Buffer.from("actual-content")
  const plane = makePlane(envd)
  await assert.rejects(
    () =>
      plane.write(
        "/conversation/f.txt",
        Buffer.from("x"),
        { createParents: true, expectedSha256: "0".repeat(64) },
        writeCtx(SCOPE)
      ),
    (err: unknown) => err instanceof StaleWriteError
  )
  assert.ok(!envd.calls.some((c) => c.startsWith("writeFile")))
})

test("write expected_sha256 match (within cap) → proceeds", async () => {
  const envd = new Envd()
  envd.statMap["/workspace/conversation/f.txt"] = file(
    "/workspace/conversation/f.txt",
    5
  )
  const prior = Buffer.from("actual-content")
  envd.readBytes = prior
  const sha = createHash("sha256").update(prior).digest("hex")
  const plane = makePlane(envd)
  await plane.write(
    "/conversation/f.txt",
    Buffer.from("new"),
    { createParents: true, expectedSha256: sha },
    writeCtx(SCOPE)
  )
  assert.ok(envd.calls.includes("writeFile:/workspace/conversation/f.txt"))
})

// ── fs_mkdir recursive ────────────────────────────────────────────────────────

test("mkdir recursive=false + missing parent → deny, no makeDir", async () => {
  const envd = new Envd()
  envd.statMap["/workspace/conversation/a"] = "missing"
  const plane = makePlane(envd)
  await assert.rejects(
    () =>
      plane.mkdir("/conversation/a/b", { recursive: false }, writeCtx(SCOPE)),
    /parent directory does not exist: \/conversation\/a/
  )
  assert.ok(!envd.calls.some((c) => c.startsWith("makeDir")))
})

test("mkdir recursive=true + missing parent → makeDir called", async () => {
  const envd = new Envd()
  envd.statMap["/workspace/conversation/a"] = "missing"
  const plane = makePlane(envd)
  await plane.mkdir("/conversation/a/b", { recursive: true }, writeCtx(SCOPE))
  assert.ok(envd.calls.includes("makeDir:/workspace/conversation/a/b"))
})

// ── fs_move overwrite / expected_source_sha256 ────────────────────────────────

test("move overwrite=false + dest exists → StaleWriteError pre_create, no move", async () => {
  const envd = new Envd()
  envd.statMap["/workspace/conversation/dst"] = file(
    "/workspace/conversation/dst"
  )
  const plane = makePlane(envd)
  await assert.rejects(
    () =>
      plane.move(
        "/conversation/src",
        "/conversation/dst",
        { overwrite: false },
        writeCtx(SCOPE)
      ),
    (err: unknown) =>
      err instanceof StaleWriteError &&
      (err as StaleWriteError).phase === "pre_create"
  )
  assert.ok(
    !envd.calls.some((c) => c.startsWith("move")),
    "no destructive move onto an existing dest"
  )
})

test("move overwrite=true + dest exists → move called", async () => {
  const envd = new Envd()
  envd.statMap["/workspace/conversation/dst"] = file(
    "/workspace/conversation/dst"
  )
  const plane = makePlane(envd)
  await plane.move(
    "/conversation/src",
    "/conversation/dst",
    { overwrite: true },
    writeCtx(SCOPE)
  )
  assert.ok(
    envd.calls.includes(
      "move:/workspace/conversation/src=>/workspace/conversation/dst"
    )
  )
})

test("move overwrite=false + dest absent → move called", async () => {
  const envd = new Envd()
  envd.statMap["/workspace/conversation/dst"] = "missing"
  const plane = makePlane(envd)
  await plane.move(
    "/conversation/src",
    "/conversation/dst",
    { overwrite: false },
    writeCtx(SCOPE)
  )
  assert.ok(
    envd.calls.includes(
      "move:/workspace/conversation/src=>/workspace/conversation/dst"
    )
  )
})

test("move expected_source_sha256 mismatch → StaleWriteError pre_rename, no move", async () => {
  const envd = new Envd()
  envd.statMap["/workspace/conversation/src"] = file(
    "/workspace/conversation/src",
    5
  )
  envd.statMap["/workspace/conversation/dst"] = "missing"
  envd.readBytes = Buffer.from("src-content")
  const plane = makePlane(envd)
  await assert.rejects(
    () =>
      plane.move(
        "/conversation/src",
        "/conversation/dst",
        { overwrite: true, expectedSourceSha256: "0".repeat(64) },
        writeCtx(SCOPE)
      ),
    (err: unknown) =>
      err instanceof StaleWriteError &&
      (err as StaleWriteError).phase === "pre_rename"
  )
  assert.ok(!envd.calls.some((c) => c.startsWith("move")))
})

test("move expected_source_sha256 + source too large → precondition_uncheckable", async () => {
  const envd = new Envd()
  envd.statMap["/workspace/conversation/src"] = file(
    "/workspace/conversation/src",
    CAPS.maxReadBytes + 1
  )
  const plane = makePlane(envd)
  await assert.rejects(
    () =>
      plane.move(
        "/conversation/src",
        "/conversation/dst",
        { overwrite: true, expectedSourceSha256: "abc" },
        writeCtx(SCOPE)
      ),
    (err: unknown) => err instanceof PreconditionUncheckableError
  )
  assert.ok(!envd.calls.some((c) => c.startsWith("move")))
})

// ── fs_remove recursive ───────────────────────────────────────────────────────

test("remove recursive=false + non-empty dir → deny, no remove", async () => {
  const envd = new Envd()
  envd.statMap["/workspace/conversation/d"] = dir("/workspace/conversation/d")
  envd.listMap["/workspace/conversation/d"] = [
    file("/workspace/conversation/d/child"),
  ]
  const plane = makePlane(envd)
  await assert.rejects(
    () =>
      plane.remove("/conversation/d", { recursive: false }, writeCtx(SCOPE)),
    /directory not empty .*: \/conversation\/d/
  )
  assert.ok(
    !envd.calls.some((c) => c.startsWith("remove")),
    "no destructive tree-delete when non-recursive"
  )
})

test("remove recursive=false + EMPTY dir → remove called", async () => {
  const envd = new Envd()
  envd.statMap["/workspace/conversation/d"] = dir("/workspace/conversation/d")
  envd.listMap["/workspace/conversation/d"] = []
  const plane = makePlane(envd)
  await plane.remove("/conversation/d", { recursive: false }, writeCtx(SCOPE))
  assert.ok(envd.calls.includes("remove:/workspace/conversation/d"))
})

test("remove recursive=false + FILE → remove called", async () => {
  const envd = new Envd()
  envd.statMap["/workspace/conversation/f"] = file("/workspace/conversation/f")
  const plane = makePlane(envd)
  await plane.remove("/conversation/f", { recursive: false }, writeCtx(SCOPE))
  assert.ok(envd.calls.includes("remove:/workspace/conversation/f"))
})

test("remove recursive=true + non-empty dir → remove called (whole tree)", async () => {
  const envd = new Envd()
  envd.statMap["/workspace/conversation/d"] = dir("/workspace/conversation/d")
  envd.listMap["/workspace/conversation/d"] = [
    file("/workspace/conversation/d/child"),
  ]
  const plane = makePlane(envd)
  await plane.remove("/conversation/d", { recursive: true }, writeCtx(SCOPE))
  assert.ok(envd.calls.includes("remove:/workspace/conversation/d"))
})

test("remove recursive=false + absent target → idempotent remove call (no error)", async () => {
  const envd = new Envd()
  envd.statMap["/workspace/conversation/gone"] = "missing"
  const plane = makePlane(envd)
  await plane.remove(
    "/conversation/gone",
    { recursive: false },
    writeCtx(SCOPE)
  )
  assert.ok(envd.calls.includes("remove:/workspace/conversation/gone"))
})
