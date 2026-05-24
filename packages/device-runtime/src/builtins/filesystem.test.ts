import test from "node:test"
import assert from "node:assert/strict"

import { createFilesystemBuiltin } from "./filesystem.js"

test("filesystem builtin returns the expected exposure + list tool", async () => {
  const builtin = createFilesystemBuiltin({
    rootPath: "/tmp/synapse-vfs-root",
  })
  const exposures = await builtin.describeExposures()
  assert.equal(exposures.length, 1)
  const fs = exposures[0]!
  assert.equal(fs.transport, "builtin")
  assert.equal(fs.builtin_kind, "filesystem")
  assert.deepEqual(fs.metadata?.rootPath, "/tmp/synapse-vfs-root")
  assert.equal(fs.tools.length, 1)
  assert.equal(fs.tools[0]!.stable_key, "filesystem/list")
})

test("filesystem builtin tolerates missing rootPath option", async () => {
  const builtin = createFilesystemBuiltin()
  const exposures = await builtin.describeExposures()
  assert.equal(exposures[0]!.metadata?.rootPath, null)
})
