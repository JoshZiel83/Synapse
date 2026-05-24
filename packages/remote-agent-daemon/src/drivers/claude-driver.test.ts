import test from "node:test"
import assert from "node:assert/strict"
import { ClaudeDriver } from "./claude-driver.js"

test("ClaudeDriver.runtimeKind is claude_code", () => {
  const driver = new ClaudeDriver()
  assert.equal(driver.runtimeKind, "claude_code")
})

test("ClaudeDriver.detect reports missing_binary when SYNAPSE_CLAUDE_PATH points nowhere and `claude` is not on PATH", () => {
  const originalPath = process.env.PATH
  const originalSynapse = process.env.SYNAPSE_CLAUDE_PATH
  process.env.PATH = "/tmp/__nonexistent_path_segment_for_test"
  delete process.env.SYNAPSE_CLAUDE_PATH
  try {
    const entry = new ClaudeDriver().detect()
    assert.equal(entry.runtimeKind, "claude_code")
    assert.equal(entry.status, "missing_binary")
    assert.equal(entry.executablePath, undefined)
  } finally {
    if (originalPath !== undefined) process.env.PATH = originalPath
    if (originalSynapse !== undefined)
      process.env.SYNAPSE_CLAUDE_PATH = originalSynapse
  }
})
