// R4 §6.8 — the ENVD working-set transport: `list` parity with `find <roots>
// -type f` (2b: regular files only, dotfiles + dotdirs descended, symlinks
// excluded), VFS-mount-rooted keys (2d), and a read/write/remove round-trip.
// DB-FREE + network-FREE: a stub RemoteEnvdTransport backed by an in-memory tree.

import test from "node:test"
import assert from "node:assert/strict"
import { Buffer } from "node:buffer"
import {
  makeDockerExecTransport,
  type DockerExecFn,
} from "../working-set-bridge.js"
import {
  makeEnvdWorkingSetTransport,
  scopeWorkingSetKey,
  WorkingSetTransportError,
} from "./working-set.js"
import { CubeEnvdNotFoundError } from "./types.js"
import type { RemoteEnvdTransport } from "./data-plane.js"
import type { FileEntry } from "./types.js"

/** A stub RemoteEnvdTransport over an explicit dir→children map (only the methods
 *  the working-set transport uses are real; the rest throw). */
function stubEnvd(dirs: Record<string, FileEntry[]>): RemoteEnvdTransport {
  const files = new Map<string, Buffer>()
  return {
    async listDir(path) {
      const key = path.replace(/\/+$/, "") || "/"
      const entries = dirs[key]
      if (!entries) throw new CubeEnvdNotFoundError(`no such dir: ${key}`)
      return entries
    },
    async readFile(path) {
      const b = files.get(path)
      if (!b) throw new CubeEnvdNotFoundError(`no such file: ${path}`)
      return b
    },
    async writeFile(path, bytes) {
      files.set(path, Buffer.from(bytes))
      return []
    },
    async remove(path) {
      files.delete(path)
    },
    async stat() {
      throw new Error("not implemented")
    },
    async exec() {
      throw new Error("not implemented")
    },
    async makeDir() {
      throw new Error("not implemented")
    },
    async move() {
      throw new Error("not implemented")
    },
    async close() {},
  }
}

const MT = "2026-01-01T00:00:00.123Z"

/** A tree with dotfiles, a nested subdir, a DOT-subdir, and a SYMLINK (excluded). */
function conversationTree(): Record<string, FileEntry[]> {
  return {
    "/workspace/conversation": [
      {
        name: "a.py",
        path: "/workspace/conversation/a.py",
        type: "file",
        size: 1,
        modifiedTime: MT,
      },
      {
        name: ".hidden",
        path: "/workspace/conversation/.hidden",
        type: "file",
        size: 2,
        modifiedTime: MT,
      },
      { name: "sub", path: "/workspace/conversation/sub", type: "directory" },
      {
        name: ".dotdir",
        path: "/workspace/conversation/.dotdir",
        type: "directory",
      },
      {
        name: "link",
        path: "/workspace/conversation/link",
        type: "symlink",
        size: 9,
        modifiedTime: MT,
      },
    ],
    "/workspace/conversation/sub": [
      {
        name: "b.txt",
        path: "/workspace/conversation/sub/b.txt",
        type: "file",
        size: 3,
        modifiedTime: MT,
      },
    ],
    "/workspace/conversation/.dotdir": [
      {
        name: "c.md",
        path: "/workspace/conversation/.dotdir/c.md",
        type: "file",
        size: 4,
        modifiedTime: MT,
      },
    ],
  }
}

test("R4 2d — envd list is VFS-mount-rooted (vmRoot stripped), files-only, dotdirs descended, symlink excluded", async () => {
  const envd = stubEnvd(conversationTree())
  const transport = makeEnvdWorkingSetTransport({ envd, vmRoot: "/workspace" })
  const listing = await transport.list(["/workspace/conversation"])
  const relpaths = listing.map((f) => f.relpath).sort()
  assert.deepEqual(relpaths, [
    "/conversation/.dotdir/c.md",
    "/conversation/.hidden",
    "/conversation/a.py",
    "/conversation/sub/b.txt",
  ])
  // symlink excluded
  assert.ok(
    !relpaths.includes("/conversation/link"),
    "a symlink is excluded (find -type f parity)"
  )
  // F6: full-ms mtimeKey present for every entry.
  for (const f of listing) {
    assert.equal(typeof f.mtimeKey, "string")
    assert.ok(f.mtimeKey && f.mtimeKey.length > 0)
  }
})

test("R4 2b — docker-vs-envd LIST PARITY: identical relpath set for the same tree", async () => {
  // Docker `find /conversation -type f` output (symlink already excluded by -type f).
  const find = [
    "1 1700000000 /conversation/a.py",
    "2 1700000000 /conversation/.hidden",
    "3 1700000000 /conversation/sub/b.txt",
    "4 1700000000 /conversation/.dotdir/c.md",
    "",
  ].join("\n")
  const exec: DockerExecFn = async (argv) => {
    if (argv.includes("find")) return { code: 0, stdout: find, stderr: "" }
    return { code: 0, stdout: "", stderr: "" }
  }
  const dockerTransport = makeDockerExecTransport({ containerId: "cid", exec })
  const dockerRel = (await dockerTransport.list(["/conversation"]))
    .map((f) => f.relpath)
    .sort()

  const envd = stubEnvd(conversationTree())
  const envdTransport = makeEnvdWorkingSetTransport({
    envd,
    vmRoot: "/workspace",
  })
  const envdRel = (await envdTransport.list(["/workspace/conversation"]))
    .map((f) => f.relpath)
    .sort()

  assert.deepEqual(
    envdRel,
    dockerRel,
    "envd listDir recursion and docker `find -type f` yield the SAME VFS-rooted key set"
  )
})

test("R4 — envd transport read/write/remove round-trip (VFS key lowered to the VM path)", async () => {
  const envd = stubEnvd({ "/workspace/conversation": [] })
  const transport = makeEnvdWorkingSetTransport({ envd, vmRoot: "/workspace" })
  await transport.write("/conversation/x.py", Buffer.from("hello"))
  const back = await transport.read("/conversation/x.py")
  assert.equal(back.toString(), "hello")
  await transport.remove("/conversation/x.py")
  await assert.rejects(() => transport.read("/conversation/x.py"))
})

test("R4 — a not-yet-created mount root lists as EMPTY (fresh VM pre-push), not an error", async () => {
  const envd = stubEnvd({}) // listDir throws NotFound for the root
  const transport = makeEnvdWorkingSetTransport({ envd, vmRoot: "/workspace" })
  const listing = await transport.list(["/workspace/conversation"])
  assert.deepEqual(listing, [])
})

// ── (R5 #1 SECURITY) path-traversal guard on the untrusted envd listing ─────────

test("#1 scopeWorkingSetKey: rejects an escaping key, accepts + collapses in-mount", () => {
  // escape past the mount root → null (dropped)
  assert.equal(
    scopeWorkingSetKey("/conversation/../../session-2/pwn", "/conversation"),
    null
  )
  assert.equal(scopeWorkingSetKey("/actor/x", "/conversation"), null)
  assert.equal(scopeWorkingSetKey("relative/no/slash", "/conversation"), null)
  // in-mount → canonical key; an in-mount `..` collapses but stays in scope
  assert.equal(
    scopeWorkingSetKey("/conversation/sub/x.py", "/conversation"),
    "/conversation/sub/x.py"
  )
  assert.equal(
    scopeWorkingSetKey("/conversation/a/../b", "/conversation"),
    "/conversation/b"
  )
  assert.equal(
    scopeWorkingSetKey("/conversation", "/conversation"),
    "/conversation"
  )
})

test("#1 a malicious envd entry with a `..` path is DROPPED from the listing (no cross-session key)", async () => {
  // Reproduce the reported attack: a compromised envd returns an entry whose path
  // escapes the mount into a sibling session. It must NEVER surface as a mirror key.
  const envd = stubEnvd({
    "/workspace/conversation": [
      {
        name: "ok.py",
        path: "/workspace/conversation/ok.py",
        type: "file",
        size: 1,
        modifiedTime: MT,
      },
      {
        name: "pwn",
        path: "/workspace/conversation/../../session-2/pwn",
        type: "file",
        size: 9,
        modifiedTime: MT,
      },
    ],
  })
  const transport = makeEnvdWorkingSetTransport({ envd, vmRoot: "/workspace" })
  const listing = await transport.list(["/workspace/conversation"])
  const keys = listing.map((f) => f.relpath)
  assert.deepEqual(
    keys,
    ["/conversation/ok.py"],
    "the `..`-escaping entry is dropped"
  )
  assert.ok(
    !keys.some((k) => k.includes("..") || k.includes("session-2")),
    "no traversal key survives"
  )
})

test("#1 a malicious DIRECTORY entry with `..` is not recursed into", async () => {
  const envd = stubEnvd({
    "/workspace/conversation": [
      {
        name: "evil",
        path: "/workspace/conversation/../../etc",
        type: "directory",
      },
    ],
    // If the guard failed, listOne would try to descend "/etc":
    "/etc": [
      {
        name: "passwd",
        path: "/etc/passwd",
        type: "file",
        size: 1,
        modifiedTime: MT,
      },
    ],
  })
  const transport = makeEnvdWorkingSetTransport({ envd, vmRoot: "/workspace" })
  const listing = await transport.list(["/workspace/conversation"])
  assert.deepEqual(
    listing,
    [],
    "the escaping dir is dropped, /etc never enumerated"
  )
})

test("#1 read/write/remove belt: a lowered VM path escaping the VM root fails loud", async () => {
  const envd = stubEnvd({})
  const transport = makeEnvdWorkingSetTransport({ envd, vmRoot: "/workspace" })
  // A relpath that lowers outside /workspace must be rejected by the transport belt.
  await assert.rejects(
    () => transport.read("/../etc/passwd"),
    (e: unknown) => e instanceof WorkingSetTransportError
  )
  await assert.rejects(
    () => transport.remove("/../etc/passwd"),
    (e: unknown) => e instanceof WorkingSetTransportError
  )
})
