// Golden-drift (F-D): the api-authored bare catalog is the descriptor-gated
// subset actually backed by a device builtin — no dead/unbacked tool, and NO pty
// in P4a. The filesystem tool DEFS derive from the resident builtin's TOOLS[]
// (filesystemCoreToolDefs), so a schema drift in the device builtin surfaces
// here.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createFilesystemBuiltin,
  createCommandlineBuiltin,
} from "@synapse/device-runtime"
import type { DeviceCatalogTool } from "@synapse/device-protocol"
import { buildBareCoreCatalog } from "./core-catalog.js"
import { buildLocalBareDescriptor } from "./adapter-registry.js"

function toolMap(tools: DeviceCatalogTool[]): Map<string, DeviceCatalogTool> {
  return new Map(tools.map((t) => [t.name, t]))
}

test("F-D: the bare catalog exposes NO pty (production) and is descriptor-gated", () => {
  const withBwrap = buildBareCoreCatalog(
    buildLocalBareDescriptor({ isolation: "bwrap" })
  )
  const kinds = withBwrap.map((e) => e.builtin_kind)
  assert.deepEqual([...kinds].sort(), ["commandline", "filesystem"])
  assert.ok(!kinds.includes("pty" as never), "no pty exposure (F-D)")
  // No exposure or tool anywhere is pty-flavored.
  for (const exp of withBwrap) {
    for (const t of exp.tools) {
      assert.ok(!/pty/i.test(t.name), `no pty tool: ${t.name}`)
    }
  }

  // isolation:null → filesystem ONLY (no commandline; fail-closed).
  const noBwrap = buildBareCoreCatalog(
    buildLocalBareDescriptor({ isolation: null })
  )
  assert.deepEqual(
    noBwrap.map((e) => e.builtin_kind),
    ["filesystem"]
  )
})

test("golden-drift: every bare filesystem tool matches the device builtin's schema for the same name", async () => {
  const root = await mkdtemp(join(tmpdir(), "synapse-drift-"))
  // Instantiate the REAL device filesystem builtin with the tool families the
  // bare catalog exposes enabled + visible (ripgrep forced present so fs_search
  // is advertised; allowUnversionedWrite so the write-family tools are visible
  // without a sqlite helper).
  const builtin = createFilesystemBuiltin({
    rootPath: root,
    enableRead: true,
    enableWrite: true,
    enableDelete: true,
    allowUnversionedWrite: true,
    ripgrepPath: process.execPath,
  })
  const exposures = await builtin.describeExposures()
  const deviceFs = exposures.find((e) => e.builtin_kind === "filesystem")
  assert.ok(deviceFs, "device advertises a filesystem exposure")
  const deviceTools = toolMap(deviceFs!.tools)

  const bare = buildBareCoreCatalog(
    buildLocalBareDescriptor({ isolation: "bwrap" })
  )
  const bareFs = bare.find((e) => e.builtin_kind === "filesystem")!
  for (const t of bareFs.tools) {
    const deviceTool = deviceTools.get(t.name)
    assert.ok(
      deviceTool,
      `bare fs tool ${t.name} is backed by the device builtin`
    )
    assert.deepEqual(
      t.input_schema,
      deviceTool!.input_schema,
      `${t.name} schema must match the device builtin (no drift)`
    )
    assert.equal(
      t.description,
      deviceTool!.description,
      `${t.name} description`
    )
  }
})

test("golden-drift: the bare commandline tools are backed by the device commandline builtin (bash + exec_file)", async () => {
  const builtin = createCommandlineBuiltin({})
  const exposures = await builtin.describeExposures()
  const deviceCmd = exposures.find((e) => e.builtin_kind === "commandline")
  assert.ok(deviceCmd, "device advertises a commandline exposure")
  const deviceTools = toolMap(deviceCmd!.tools)

  const bare = buildBareCoreCatalog(
    buildLocalBareDescriptor({ isolation: "bwrap" })
  )
  const bareCmd = bare.find((e) => e.builtin_kind === "commandline")!
  for (const t of bareCmd.tools) {
    const deviceTool = deviceTools.get(t.name)
    assert.ok(deviceTool, `bare commandline tool ${t.name} is device-backed`)
    assert.deepEqual(
      t.input_schema,
      deviceTool!.input_schema,
      `${t.name} schema`
    )
  }
})
