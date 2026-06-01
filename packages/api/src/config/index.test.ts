import test from "node:test"
import assert from "node:assert/strict"

// config/index.ts validates process.env at import time and exits on failure.
// Here we only assert the happy-path shape/defaults/coercion are preserved
// (range/format rejection is covered by the schema itself; exercising the
// process.exit(1) path would kill the test runner).
const { config } = await import("./index.js")

test("numeric env values are coerced to numbers with the documented defaults", () => {
  assert.equal(typeof config.port, "number")
  assert.equal(config.port, 3001)
  assert.equal(config.realtime.outboxBatchSize, 100)
  assert.equal(config.realtime.outboxPollMs, 500)
  assert.equal(config.asr.volcengine.maxConcurrency, 3)
  assert.equal(config.ai.maxTokens, 4096)
  assert.equal(config.memory.embedBatchSize, 12)
})

test("float env values coerce to floats", () => {
  assert.equal(config.memory.mmrLambda, 0.8)
  assert.equal(config.memory.summaryDecayFloor, 0.35)
  assert.equal(config.memory.summaryDecayHalfLifeDays, 30)
})

test("string defaults are preserved", () => {
  assert.equal(config.host, "0.0.0.0")
  assert.equal(config.nodeEnv, "development")
  assert.equal(config.asr.provider, "volcengine")
  assert.equal(config.imageFallback.provider, "tesseract")
})

test("memory.topK falls back to recallLimit when unset", () => {
  assert.equal(config.memory.topK, config.memory.recallLimit)
})

test("list-valued env vars parse into arrays", () => {
  assert.ok(Array.isArray(config.platform.adminEmails))
  assert.ok(Array.isArray(config.skills.import.githubRawProxyPrefixes))
})
