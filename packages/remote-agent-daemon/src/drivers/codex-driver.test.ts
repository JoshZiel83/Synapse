import test from "node:test"
import assert from "node:assert/strict"
import { CodexDriver } from "./codex-driver.js"

test("CodexDriver.runtimeKind is codex", () => {
  assert.equal(new CodexDriver().runtimeKind, "codex")
})

test("CodexDriver.detect reports missing_binary when no codex on PATH", () => {
  const originalPath = process.env.PATH
  const originalSynapse = process.env.SYNAPSE_CODEX_PATH
  process.env.PATH = "/tmp/__nonexistent_path_segment_for_test_codex"
  delete process.env.SYNAPSE_CODEX_PATH
  try {
    const entry = new CodexDriver().detect()
    assert.equal(entry.runtimeKind, "codex")
    assert.equal(entry.status, "missing_binary")
    assert.equal(entry.executablePath, undefined)
  } finally {
    if (originalPath !== undefined) process.env.PATH = originalPath
    if (originalSynapse !== undefined)
      process.env.SYNAPSE_CODEX_PATH = originalSynapse
  }
})
