// CUA builtin smoke test. Exercises the real synapse-device-cua-helper binary
// when it can be found, and falls back to a stub if not (CI without a built
// helper). We deliberately do NOT trigger click/type_text here — those side
// effects would be surprising on a developer workstation.

import test from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { join } from "node:path"

import { createCuaBuiltin } from "./cua.js"

function locateHelper(): string | null {
  const explicit = process.env.SYNAPSE_DEVICE_CUA_HELPER_PATH
  if (explicit && existsSync(explicit)) return explicit
  const candidate = join(
    process.cwd(),
    "..",
    "..",
    "sidecars",
    "cua",
    "synapse-device-cua-helper"
  )
  if (existsSync(candidate)) return candidate
  return null
}

test("cua builtin exposes 4 tools + cua builtin_kind", async () => {
  const builtin = createCuaBuiltin({ helperPath: "/tmp/unused" })
  const exposures = await builtin.describeExposures()
  assert.equal(exposures.length, 1)
  assert.equal(exposures[0]!.builtin_kind, "cua")
  const names = exposures[0]!.tools.map((t) => t.name)
  assert.deepEqual(names.sort(), [
    "cua_capture_display",
    "cua_click",
    "cua_list_displays",
    "cua_type_text",
  ])
})

test("cua builtin returns structured error when helper path is missing", async () => {
  const builtin = createCuaBuiltin({})
  // Force the env var to be empty for this call so the missing-path branch
  // fires deterministically.
  const prior = process.env.SYNAPSE_DEVICE_CUA_HELPER_PATH
  delete process.env.SYNAPSE_DEVICE_CUA_HELPER_PATH
  try {
    const result = await builtin.invokeTool!({
      toolName: "cua_list_displays",
      args: {},
    })
    assert.equal(result.isError, true)
    const synapseError = result._meta?.["synapse_error"] as
      | { code: string; message: string }
      | undefined
    assert.equal(synapseError?.code, "runtime_constraint")
  } finally {
    if (prior !== undefined) process.env.SYNAPSE_DEVICE_CUA_HELPER_PATH = prior
  }
})

test("cua builtin proxies list_displays through the real helper when available", async () => {
  // Live test is opt-in: it spawns the Go helper binary and would keep the
  // node process alive (no `npm test --test-force-exit` in this package), so
  // we gate behind SYNAPSE_DEVICE_CUA_HELPER_LIVE_TEST. Run with:
  //   SYNAPSE_DEVICE_CUA_HELPER_LIVE_TEST=1 \
  //   SYNAPSE_DEVICE_CUA_HELPER_PATH=sidecars/cua/synapse-device-cua-helper \
  //   npm test
  if (!process.env.SYNAPSE_DEVICE_CUA_HELPER_LIVE_TEST) return
  const helper = locateHelper()
  if (!helper) return
  const builtin = createCuaBuiltin({ helperPath: helper })
  const result = await builtin.invokeTool!({
    toolName: "cua_list_displays",
    args: {},
  })
  assert.equal(typeof result.content[0], "object")
  if (!result.isError) {
    const payload = JSON.parse(
      (result.content[0] as { type: string; text: string }).text
    ) as { displays: unknown[] }
    assert.ok(Array.isArray(payload.displays))
  }
})
