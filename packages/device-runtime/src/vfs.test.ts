import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createLocalFsBackend, createVfsService } from "./vfs.js"

test("VfsService local backend lists + reads files", async () => {
  const root = mkdtempSync(join(tmpdir(), "synapse-vfs-"))
  try {
    mkdirSync(join(root, "sub"))
    writeFileSync(join(root, "sub", "hello.txt"), "hi from vfs")
    const backend = createLocalFsBackend({ rootPath: root })
    const svc = createVfsService({ backend })
    await svc.start()
    const entries = await svc.list("/sub")
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.name, "hello.txt")
    const read = await svc.read("/sub/hello.txt")
    assert.equal(Buffer.from(read.data).toString("utf8"), "hi from vfs")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("VfsService exposure registry + sessions", () => {
  const svc = createVfsService({
    backend: createLocalFsBackend({ rootPath: "/tmp" }),
  })
  svc.registerExposure({
    capability: "filesystem",
    stableKey: "fs-home",
    name: "Home",
  })
  assert.equal(svc.listExposures().length, 1)
  const session = svc.openSession({
    capability: "filesystem",
    exposureStableKey: "fs-home",
    runtimeSessionId: "rt-1",
  })
  assert.equal(session.runtimeSessionId, "rt-1")
  svc.closeSession(session.sessionId)
})

test("VfsService local backend rejects ../ escapes", async () => {
  const root = mkdtempSync(join(tmpdir(), "synapse-vfs-trav-"))
  try {
    writeFileSync(join(root, "inside.txt"), "ok")
    // Drop a sibling file outside the root that an escape would target.
    const outsideDir = mkdtempSync(join(tmpdir(), "synapse-vfs-outside-"))
    writeFileSync(join(outsideDir, "secret.txt"), "leak")
    const backend = createLocalFsBackend({ rootPath: root })
    const svc = createVfsService({ backend })
    await svc.start()

    // canonicalVfsPath bounds `..` at root: `/../../etc/passwd` collapses to
    // `/etc/passwd`, mapping to `<root>/etc/passwd` which doesn't exist. The
    // read therefore fails with ENOENT, not an escape error — but the outside
    // file remains unreachable, which is the actual safety property.
    await assert.rejects(() => svc.read("/../../etc/passwd"))
    // `/../escape.txt` collapses to `/escape.txt` — write succeeds INSIDE
    // the root. Verify the file landed inside, not at the parent.
    await svc.write("/../escape.txt", new Uint8Array([1]))
    assert.ok(
      await import("node:fs").then((f) =>
        f.promises.stat(join(root, "escape.txt")).then(
          () => true,
          () => false
        )
      ),
      "write should have landed inside root"
    )
    // stat returns null for non-existent paths inside the root.
    assert.equal(await svc.stat("/../foo"), null)

    rmSync(outsideDir, { recursive: true, force: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("VfsService list_dir uses lstat — symlink kind exposed, target metadata withheld", async () => {
  const { symlinkSync } = await import("node:fs")
  const root = mkdtempSync(join(tmpdir(), "synapse-vfs-symlink-"))
  // Create a SECRET file outside the root; the symlink would otherwise
  // leak its size + mtime through fs.stat().
  const secretDir = mkdtempSync(join(tmpdir(), "synapse-vfs-secret-"))
  const secretPath = join(secretDir, "secret.txt")
  writeFileSync(secretPath, "leak-this-is-30-bytes-of-secret") // gitleaks:allow — test-only fixture
  try {
    mkdirSync(join(root, "public"))
    writeFileSync(join(root, "public", "real.txt"), "ok")
    // /public/link → /<secretDir>/secret.txt
    symlinkSync(secretPath, join(root, "public", "link"))
    // Plus a broken link to verify it isn't silently skipped — its mere
    // existence is itself a side channel.
    symlinkSync("/nonexistent/target", join(root, "public", "broken"))

    const backend = createLocalFsBackend({ rootPath: root })
    const svc = createVfsService({ backend })
    await svc.start()
    const entries = await svc.list("/public")
    const names = entries.map((e) => e.name).sort()
    assert.deepEqual(names, ["broken", "link", "real.txt"])
    const link = entries.find((e) => e.name === "link")!
    const broken = entries.find((e) => e.name === "broken")!
    const real = entries.find((e) => e.name === "real.txt")!
    // Symlinks must surface as kind="symlink", NOT "file"/"directory".
    assert.equal(link.kind, "symlink")
    assert.equal(broken.kind, "symlink")
    assert.equal(real.kind, "file")
    // Symlinks must NOT leak the target's size.
    assert.equal(link.size, undefined)
    assert.equal(broken.size, undefined)
    // Real file's size IS exposed (no leak — it's inside the root).
    assert.equal(real.size, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(secretDir, { recursive: true, force: true })
  }
})
