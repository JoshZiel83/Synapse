// cubesandbox:bare data-plane unit tests (no network — a stub envd transport).
//
// The SECURITY CORE is LEXICAL path confinement (off-box CANNOT realpath a remote
// fs). These tests prove: (1) an out-of-scope / escaping / absolute path is DENIED
// BEFORE any envd call, with the SAME GrantPrefixDeniedError the host planes raise;
// (2) an in-scope path lowers to `${vmRoot}${canonical}` on the wire; (3) envd
// result paths are back-translated (VM root stripped) so no `/workspace/...` leaks;
// (4) MakeDir 409 already_exists maps to {created:false}, not an error.

import test from "node:test"
import assert from "node:assert/strict"
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { WHOLE_SCOPE, GrantPrefixDeniedError } from "@synapse/device-runtime"
import { buildCubesandboxBareDescriptor } from "../model.js"
import type { ConfinementCtx, ConfinementScope } from "../data-plane.js"
import {
  createRemoteBareDataPlane,
  type RemoteEnvdTransport,
} from "./data-plane.js"
import { CubeEnvdError, type ExecResult, type FileEntry } from "./types.js"

const descriptor = buildCubesandboxBareDescriptor()
const VM_ROOT = "/workspace"

function readCtx(scope: ConfinementScope): ConfinementCtx {
  return { scope, access: "read" }
}
function writeCtx(scope: ConfinementScope): ConfinementCtx {
  return { scope, access: "write" }
}

interface StatCall {
  method: string
  path: string
}

/** A recording stub of the envd transport with per-method overridable behavior. */
class StubEnvd implements RemoteEnvdTransport {
  readonly calls: StatCall[] = []
  statImpl: (path: string) => Promise<FileEntry> = async (path) => ({
    name: "f",
    path,
    type: "file",
    size: 11,
    modifiedTime: "2026-07-13T00:00:00Z",
  })
  listImpl: (path: string) => Promise<FileEntry[]> = async () => []
  makeDirImpl: (path: string) => Promise<FileEntry> = async (path) => ({
    name: "d",
    path,
    type: "directory",
  })
  readImpl: () => Promise<Buffer> = async () => Buffer.from("hello world")
  writeImpl: () => Promise<FileEntry[]> = async () => []
  moveImpl: (source: string, destination: string) => Promise<FileEntry> =
    async (_source, destination) => ({
      name: "m",
      path: destination,
      type: "file",
    })

  async exec(): Promise<ExecResult> {
    return { exitCode: 0, stdout: "", stderr: "" }
  }
  async stat(path: string): Promise<FileEntry> {
    this.calls.push({ method: "stat", path })
    return this.statImpl(path)
  }
  async listDir(path: string): Promise<FileEntry[]> {
    this.calls.push({ method: "listDir", path })
    return this.listImpl(path)
  }
  async makeDir(path: string): Promise<FileEntry> {
    this.calls.push({ method: "makeDir", path })
    return this.makeDirImpl(path)
  }
  async move(source: string, destination: string): Promise<FileEntry> {
    this.calls.push({ method: "move", path: `${source}=>${destination}` })
    return this.moveImpl(source, destination)
  }
  async remove(path: string): Promise<void> {
    this.calls.push({ method: "remove", path })
  }
  async readFile(path: string): Promise<Buffer> {
    this.calls.push({ method: "readFile", path })
    return this.readImpl()
  }
  async writeFile(path: string, bytes: Uint8Array): Promise<FileEntry[]> {
    this.calls.push({ method: "writeFile", path })
    void bytes
    return this.writeImpl()
  }
  async close(): Promise<void> {}
}

function makePlane(envd: RemoteEnvdTransport) {
  return createRemoteBareDataPlane({
    sandboxID: "sbx-test",
    descriptor,
    vmRoot: VM_ROOT,
    envd,
  })
}

// ── (1) LEXICAL confinement DENIES before any envd call ───────────────────────

for (const badPath of [
  "/etc/passwd", // absolute, outside the granted prefix
  "/conversation/../../etc/passwd", // `..`-escape that canonicalizes OUT of scope
  "/actor/secret.txt", // a sibling mount not in this scoped grant
]) {
  test(`confinement: '${badPath}' under a /conversation grant DENIES with no envd call`, async () => {
    const envd = new StubEnvd()
    const plane = makePlane(envd)
    await assert.rejects(
      () => plane.stat(badPath, readCtx(["/conversation"])),
      (err: unknown) => err instanceof GrantPrefixDeniedError,
      "an out-of-scope path must throw GrantPrefixDeniedError"
    )
    assert.equal(
      envd.calls.length,
      0,
      "the transport must NEVER be dialed for a denied path"
    )
  })
}

test("confinement: a bare '..' escape canonicalizes out of scope and DENIES", async () => {
  const envd = new StubEnvd()
  const plane = makePlane(envd)
  await assert.rejects(
    () => plane.read("../etc/passwd", {}, readCtx(["/conversation"])),
    (err: unknown) => err instanceof GrantPrefixDeniedError
  )
  assert.equal(envd.calls.length, 0)
})

test("confinement: WHOLE_SCOPE allows a mount root but DENIES /etc/passwd", async () => {
  const envd = new StubEnvd()
  const plane = makePlane(envd)
  // under a mount root → allowed (envd IS dialed)
  const ok = await plane.stat("/actor/report.md", readCtx(WHOLE_SCOPE))
  assert.equal(ok.exists, true)
  assert.equal(
    envd.calls.at(-1)?.path,
    "/workspace/actor/report.md",
    "an in-scope path lowers to ${vmRoot}${canonical} on the wire"
  )
  // outside every mount root → denied even under WHOLE_SCOPE
  await assert.rejects(
    () => plane.stat("/etc/passwd", readCtx(WHOLE_SCOPE)),
    (err: unknown) => err instanceof GrantPrefixDeniedError
  )
})

// ── (2) in-scope lowering to the VM root ──────────────────────────────────────

test("lowering: an in-scope path dials envd at ${vmRoot}${canonical}", async () => {
  const envd = new StubEnvd()
  const plane = makePlane(envd)
  const st = await plane.stat(
    "/conversation/hello.txt",
    readCtx(["/conversation"])
  )
  assert.equal(
    envd.calls[0]?.path,
    "/workspace/conversation/hello.txt",
    "the VM path is vmRoot + canonical VFS path"
  )
  // the returned stat path is the VFS canonical, NOT the VM path (no leak)
  assert.equal(st.path, "/conversation/hello.txt")
})

// ── (3) back-translation strips the VM root from envd result paths ────────────

test("back-translation: list entries return VFS paths, never /workspace/...", async () => {
  const envd = new StubEnvd()
  envd.listImpl = async () => [
    {
      name: "a.txt",
      path: "/workspace/conversation/a.txt",
      type: "file",
      size: 3,
    },
    { name: "sub", path: "/workspace/conversation/sub", type: "directory" },
  ]
  const plane = makePlane(envd)
  const entries = await plane.list("/conversation", readCtx(["/conversation"]))
  assert.deepEqual(
    entries.map((e) => e.path),
    ["/conversation/a.txt", "/conversation/sub"],
    "the VM root is stripped so only VFS paths reach the model"
  )
  for (const e of entries) {
    assert.ok(!e.path.includes("/workspace"), `no VM-root leak in ${e.path}`)
  }
})

test("back-translation: a bare/relative envd entry path falls back to dir+name (no leak)", async () => {
  const envd = new StubEnvd()
  // envd returns just the basename (not an absolute VM path) → compose from the dir.
  envd.listImpl = async () => [
    { name: "note.md", path: "note.md", type: "file" },
  ]
  const plane = makePlane(envd)
  const entries = await plane.list("/conversation", readCtx(WHOLE_SCOPE))
  assert.equal(entries[0]?.path, "/conversation/note.md")
})

// ── (4) MakeDir 409 already_exists → {created:false} (NOT an error) ───────────

test("mkdir: a fresh directory returns created:true", async () => {
  const envd = new StubEnvd()
  const plane = makePlane(envd)
  const res = await plane.mkdir(
    "/conversation/new",
    {},
    writeCtx(["/conversation"])
  )
  assert.deepEqual(res, { created: true })
  assert.equal(envd.calls[0]?.path, "/workspace/conversation/new")
})

test("mkdir: an EXISTING directory (409 already_exists) maps to created:false", async () => {
  const envd = new StubEnvd()
  envd.makeDirImpl = async () => {
    throw new CubeEnvdError(
      "makeDir failed: already_exists",
      409,
      "already_exists"
    )
  }
  const plane = makePlane(envd)
  const res = await plane.mkdir(
    "/conversation/dup",
    {},
    writeCtx(["/conversation"])
  )
  assert.deepEqual(
    res,
    { created: false },
    "a 409 already_exists is a no-op success, not an error"
  )
})

test("mkdir: a NON-409 envd error still propagates", async () => {
  const envd = new StubEnvd()
  envd.makeDirImpl = async () => {
    throw new CubeEnvdError("makeDir failed: boom", 500)
  }
  const plane = makePlane(envd)
  await assert.rejects(
    () => plane.mkdir("/conversation/x", {}, writeCtx(["/conversation"])),
    (err: unknown) => err instanceof CubeEnvdError
  )
})

// ── write-access + move (single grant frame over BOTH endpoints) ──────────────

test("write-access: a READ grant cannot mutate (mkdir/write/move/remove)", async () => {
  const envd = new StubEnvd()
  const plane = makePlane(envd)
  await assert.rejects(() =>
    plane.mkdir("/conversation/x", {}, readCtx(["/conversation"]))
  )
  await assert.rejects(() =>
    plane.write(
      "/conversation/x",
      new Uint8Array(1),
      {},
      readCtx(["/conversation"])
    )
  )
  assert.equal(envd.calls.length, 0, "no envd mutation under a read grant")
})

test("move: BOTH endpoints are confined under the SAME scope frame", async () => {
  const envd = new StubEnvd()
  const plane = makePlane(envd)
  // dest escaping the grant → denied even though src is in-scope.
  await assert.rejects(
    () =>
      plane.move(
        "/conversation/a",
        "/actor/b",
        {},
        writeCtx(["/conversation"])
      ),
    (err: unknown) => err instanceof GrantPrefixDeniedError
  )
  assert.equal(envd.calls.length, 0)
  // both in-scope → lowered on the wire.
  const res = await plane.move(
    "/conversation/a",
    "/conversation/b",
    {},
    writeCtx(["/conversation"])
  )
  assert.equal(
    envd.calls.at(-1)?.path,
    "/workspace/conversation/a=>/workspace/conversation/b"
  )
  assert.ok(Number.isFinite(res.mtimeMs))
})

// ── read: range window + totalSize via stat, not-found surfaces ───────────────

test("read: returns totalSize from stat and honors a maxBytes cap (truncated)", async () => {
  const envd = new StubEnvd()
  envd.statImpl = async (path) => ({
    name: "f",
    path,
    type: "file",
    size: 11,
    modifiedTime: "2026-07-13T00:00:00Z",
  })
  envd.readImpl = async () => Buffer.from("hello")
  const plane = makePlane(envd)
  const r = await plane.read(
    "/conversation/hello.txt",
    { maxBytes: 5 },
    readCtx(["/conversation"])
  )
  assert.equal(r.totalSize, 11)
  assert.equal(r.truncated, true, "5 of 11 bytes → truncated")
  assert.equal(Buffer.from(r.bytes).toString("utf-8"), "hello")
})

// ── (M1) advisory sha pre-check is bounded by the read cap (no OOM on a huge file)

test("M1: an oversize prior file (size > maxReadBytes) SKIPS the sha pre-check read", async () => {
  const envd = new StubEnvd()
  const big = descriptor.core.maxReadBytes + 1
  envd.statImpl = async (path) => ({
    name: "f",
    path,
    type: "file",
    size: big, // larger than the read cap → un-affordable to hash
    modifiedTime: "2026-07-13T00:00:00Z",
  })
  const plane = makePlane(envd)
  const res = await plane.write(
    "/conversation/big.bin",
    new Uint8Array(4),
    { expectedSha256: "deadbeef".repeat(8) },
    writeCtx(["/conversation"])
  )
  // The whole-file hash read must NOT be performed (that is the memory-DoS the guard
  // prevents — an agent could stage a multi-GB file to OOM the shared API process).
  assert.equal(
    envd.calls.some((c) => c.method === "readFile"),
    false,
    "readFile must NOT be called for an oversize prior file (advisory guard skipped)"
  )
  // The write still proceeds (advisory posture degrades gracefully — no StaleWrite).
  assert.equal(
    envd.calls.some((c) => c.method === "writeFile"),
    true,
    "the write proceeds without the un-affordable stale check"
  )
  assert.equal(res.bytesWritten, 4)
})

test("M1: an in-cap prior file still runs the sha pre-check (readFile IS invoked)", async () => {
  const envd = new StubEnvd()
  // default statImpl size 11 (< maxReadBytes); default readImpl returns "hello world".
  const sha = createHash("sha256")
    .update(Buffer.from("hello world"))
    .digest("hex")
  const plane = makePlane(envd)
  const res = await plane.write(
    "/conversation/small.txt",
    new Uint8Array(2),
    { expectedSha256: sha },
    writeCtx(["/conversation"])
  )
  assert.equal(
    envd.calls.some((c) => c.method === "readFile"),
    true,
    "an in-cap file IS hashed for the advisory sha pre-check"
  )
  assert.equal(res.bytesWritten, 2)
})

// ── (m3) an envd op error surfaced to the model must not leak the in-VM root ──────

test("m3: a non-404 envd error surfaced from an op does NOT contain the vmRoot", async () => {
  const envd = new StubEnvd()
  envd.statImpl = async () => {
    throw new CubeEnvdError(
      "filesystem Stat failed: internal: /workspace/conversation/secret.txt unreadable",
      500
    )
  }
  const plane = makePlane(envd)
  await assert.rejects(
    () => plane.stat("/conversation/secret.txt", readCtx(["/conversation"])),
    (err: unknown) => {
      assert.ok(err instanceof CubeEnvdError, "the error TYPE is preserved")
      assert.ok(
        !err.message.includes("/workspace"),
        `the in-VM root must be stripped from the surfaced message: ${err.message}`
      )
      assert.ok(
        err.message.includes("/conversation/secret.txt"),
        "the canonical VFS path survives the scrub"
      )
      return true
    }
  )
})
