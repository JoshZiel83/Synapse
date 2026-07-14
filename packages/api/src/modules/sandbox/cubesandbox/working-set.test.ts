// R4 §6.8 — the ENVD working-set transport: `list` parity with `find <roots>
// -type f` (2b: regular files only, dotfiles + dotdirs descended, symlinks
// excluded), VFS-mount-rooted keys (2d), and a read/write/remove round-trip.
// DB-FREE + network-FREE: a stub RemoteEnvdTransport backed by an in-memory tree.

import test from "node:test"
import assert from "node:assert/strict"
import { Buffer } from "node:buffer"
import {
  mkdtemp,
  mkdir,
  symlink,
  stat,
  readFile,
  rm,
  writeFile as fsWriteFile,
} from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  makeDockerExecTransport,
  type DockerExecFn,
} from "../working-set-bridge.js"
import {
  makeEnvdWorkingSetTransport,
  createCubeEnvdWorkingSetBridge,
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

test("#5 — an EMPTY nested directory is emitted as a kind:'dir' entry (round-trips); the mount root is not", async () => {
  // conversation/ has one file + one EMPTY subdir. The empty subdir has no file to
  // imply it, so it must surface as its own 'dir' entry or it is lost.
  const tree: Record<string, FileEntry[]> = {
    "/workspace/conversation": [
      {
        name: "a.py",
        path: "/workspace/conversation/a.py",
        type: "file",
        size: 1,
        modifiedTime: MT,
      },
      {
        name: "empty",
        path: "/workspace/conversation/empty",
        type: "directory",
      },
    ],
    "/workspace/conversation/empty": [], // the empty dir
  }
  const transport = makeEnvdWorkingSetTransport({
    envd: stubEnvd(tree),
    vmRoot: "/workspace",
  })
  const listing = await transport.list(["/workspace/conversation"])
  const dirs = listing.filter((e) => e.kind === "dir").map((e) => e.relpath)
  const files = listing.filter((e) => e.kind === "file").map((e) => e.relpath)
  assert.deepEqual(
    dirs,
    ["/conversation/empty"],
    "the empty subdir round-trips"
  )
  assert.deepEqual(files, ["/conversation/a.py"], "the file is a 'file' entry")
  // The mount root itself is NEVER emitted (it always exists as the mount).
  assert.ok(!listing.some((e) => e.relpath === "/conversation"))
})

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

// ── R6 #1: off-box mirror symlink escape is neutralized (no host write) ─────────

/** A stub envd whose tree lists `evil/escaped.txt` and returns bytes for it. */
function stubEnvdWithFile(
  dirs: Record<string, FileEntry[]>,
  files: Record<string, string>
): RemoteEnvdTransport {
  return {
    async listDir(path) {
      const key = path.replace(/\/+$/, "") || "/"
      const entries = dirs[key]
      if (!entries) throw new CubeEnvdNotFoundError(`no such dir: ${key}`)
      return entries
    },
    async readFile(path) {
      const b = files[path]
      if (b === undefined)
        throw new CubeEnvdNotFoundError(`no such file: ${path}`)
      return Buffer.from(b)
    },
    async writeFile() {
      return []
    },
    async remove() {},
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

test("#1 SECURITY — a base-materialized mirror symlink is NEUTRALIZED on PULL; the VM file lands INSIDE the mirror, never at the symlink target", async () => {
  const sandboxRoot = await mkdtemp(join(tmpdir(), "ws-symlink-"))
  const outside = await mkdtemp(join(tmpdir(), "ws-OUTSIDE-"))
  const mountDir = join(sandboxRoot, "conversation")
  await mkdir(mountDir, { recursive: true })
  // CAS materialized `evil` as a REAL host symlink pointing OUTSIDE the mirror.
  await symlink(outside, join(mountDir, "evil"))

  // The VM has a real dir `evil` (agent did `mkdir evil && echo PWN > evil/escaped.txt`).
  const tree: Record<string, FileEntry[]> = {
    "/workspace/conversation": [
      {
        name: "evil",
        path: "/workspace/conversation/evil",
        type: "directory",
      },
    ],
    "/workspace/conversation/evil": [
      {
        name: "escaped.txt",
        path: "/workspace/conversation/evil/escaped.txt",
        type: "file",
        size: 3,
        modifiedTime: MT,
      },
    ],
  }
  const bridge = createCubeEnvdWorkingSetBridge({
    envd: stubEnvdWithFile(tree, {
      "/workspace/conversation/evil/escaped.txt": "PWN",
    }),
    vmRoot: "/workspace",
    statCache: new Map(),
  }) as unknown as { pull(input: { dir: string }): Promise<void> }

  await bridge.pull({ dir: mountDir })

  // The escape file must NOT have been written through the symlink to OUTSIDE.
  assert.ok(
    !existsSync(join(outside, "escaped.txt")),
    "no write escaped to the symlink target (host write blocked)"
  )
  // It lands INSIDE the mirror as a real file, with the symlink replaced by a real dir.
  assert.ok(
    (await stat(join(mountDir, "evil"))).isDirectory(),
    "the mirror symlink was replaced by a real directory"
  )
  assert.equal(
    (await readFile(join(mountDir, "evil", "escaped.txt"))).toString(),
    "PWN"
  )

  await rm(sandboxRoot, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

test("#1 SECURITY — PUSH never reads THROUGH a mirror symlink (no host-file exfil into the VM)", async () => {
  const sandboxRoot = await mkdtemp(join(tmpdir(), "ws-symread-"))
  const outside = await mkdtemp(join(tmpdir(), "ws-SECRET-"))
  await fsWriteFile(join(outside, "secret"), "TOPSECRET")
  const mountDir = join(sandboxRoot, "conversation")
  await mkdir(mountDir, { recursive: true })
  // A real file (legit) + a symlink pointing at a host secret dir.
  await fsWriteFile(join(mountDir, "a.txt"), "legit")
  await symlink(outside, join(mountDir, "link"))

  // Spy envd: record every writeFile path the PUSH sends to the VM.
  const pushed: Array<{ path: string; body: string }> = []
  const spy: RemoteEnvdTransport = {
    async listDir() {
      return []
    },
    async readFile() {
      throw new CubeEnvdNotFoundError("n/a")
    },
    async writeFile(path, bytes) {
      pushed.push({ path, body: Buffer.from(bytes).toString() })
      return []
    },
    async remove() {},
    async stat() {
      throw new Error("n/a")
    },
    async exec() {
      throw new Error("n/a")
    },
    async makeDir() {
      throw new Error("n/a")
    },
    async move() {
      throw new Error("n/a")
    },
    async close() {},
  }
  const bridge = createCubeEnvdWorkingSetBridge({
    envd: spy,
    vmRoot: "/workspace",
    statCache: new Map(),
  }) as unknown as {
    applyManifest(input: {
      manifestSha256?: string
      targetDir: string
    }): Promise<void>
  }
  await bridge.applyManifest({ manifestSha256: undefined, targetDir: mountDir })

  // Only the real file was pushed; the symlink (and the host secret behind it) never
  // reached the VM — walkMirror skips symlink dirents, so readMirrorFile is never even
  // called on the symlinked path.
  assert.deepEqual(
    pushed.map((p) => p.body).sort(),
    ["legit"],
    "only the legit file's bytes were pushed"
  )
  assert.ok(
    !pushed.some((p) => p.body.includes("TOPSECRET")),
    "the host secret behind the symlink was NEVER pushed to the VM"
  )

  await rm(sandboxRoot, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})
