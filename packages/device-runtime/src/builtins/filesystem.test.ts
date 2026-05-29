import test from "node:test"
import assert from "node:assert/strict"

import { createFilesystemBuiltin } from "./filesystem.js"

test("filesystem builtin returns the expected exposure shape", async () => {
  const builtin = createFilesystemBuiltin({
    rootPath: "/tmp/synapse-vfs-root",
  })
  const exposures = await builtin.describeExposures()
  assert.equal(exposures.length, 1)
  const fs = exposures[0]!
  assert.equal(fs.transport, "builtin")
  assert.equal(fs.builtin_kind, "filesystem")
  assert.deepEqual(fs.metadata?.rootPath, "/tmp/synapse-vfs-root")
  // v3 defaults: read on, write/delete off, no helper, no rg → list_dir +
  // fs_stat + fs_read always; live search hidden when rg unavailable.
  const names = fs.tools.map((t) => t.name).sort()
  assert.ok(names.includes("list_dir"))
  assert.ok(names.includes("fs_stat"))
  assert.ok(names.includes("fs_read"))
  // write/edit/delete absent (defaults off)
  assert.ok(!names.includes("fs_write"))
  assert.ok(!names.includes("fs_edit"))
  assert.ok(!names.includes("fs_delete"))
})

test("filesystem builtin tolerates missing rootPath option", async () => {
  const builtin = createFilesystemBuiltin()
  const exposures = await builtin.describeExposures()
  assert.equal(exposures[0]!.metadata?.rootPath, null)
})
