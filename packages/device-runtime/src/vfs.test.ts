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

    await assert.rejects(() => svc.read("/../../etc/passwd"), /escapes root/)
    await assert.rejects(
      () => svc.write("/../escape.txt", new Uint8Array([1])),
      /escapes root/
    )
    assert.equal(await svc.stat("/../foo"), null)

    rmSync(outsideDir, { recursive: true, force: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
