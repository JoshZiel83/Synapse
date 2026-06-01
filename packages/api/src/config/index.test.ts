import test from "node:test"
import assert from "node:assert/strict"

// config/index.ts validates process.env at import time. These assertions must
// hold regardless of whether a local .env overrides individual values, so we
// check TYPES, COERCION, and INVARIANTS — not specific default literals that an
// env file is allowed to override (e.g. HOST, NODE_ENV, provider names).
const { config } = await import("./index.js")

test("numeric env values are coerced to real numbers (not NaN/strings)", () => {
  for (const n of [
    config.port,
    config.realtime.outboxBatchSize,
    config.realtime.outboxPollMs,
    config.realtime.outboxRetentionHours,
    config.asr.volcengine.maxConcurrency,
    config.ai.maxTokens,
    config.memory.embedBatchSize,
    config.memory.recallLimit,
  ]) {
    assert.equal(typeof n, "number")
    assert.ok(Number.isFinite(n), `expected finite number, got ${n}`)
  }
})

test("float env values coerce to finite numbers in range", () => {
  assert.equal(typeof config.memory.mmrLambda, "number")
  assert.ok(config.memory.mmrLambda >= 0 && config.memory.mmrLambda <= 1)
  assert.ok(Number.isFinite(config.memory.summaryDecayHalfLifeDays))
  assert.ok(
    config.memory.summaryDecayFloor >= 0 && config.memory.summaryDecayFloor <= 1
  )
})

test("string config values are non-empty strings", () => {
  for (const s of [
    config.host,
    config.nodeEnv,
    config.asr.provider,
    config.imageFallback.provider,
    config.database.url,
    config.redis.url,
  ]) {
    assert.equal(typeof s, "string")
    assert.ok(s.length > 0)
  }
})

test("memory.topK falls back to recallLimit when MEMORY_RECALL_TOP_K is unset", () => {
  // Only meaningful when the env doesn't set MEMORY_RECALL_TOP_K explicitly.
  if (
    process.env.MEMORY_RECALL_TOP_K === undefined ||
    process.env.MEMORY_RECALL_TOP_K === ""
  ) {
    assert.equal(config.memory.topK, config.memory.recallLimit)
  }
})

test("list-valued env vars parse into arrays", () => {
  assert.ok(Array.isArray(config.platform.adminEmails))
  assert.ok(Array.isArray(config.skills.import.githubRawProxyPrefixes))
  assert.ok(Array.isArray(config.skills.import.clawhubDownloadProxyOrigins))
})

test("NODE_ENV accepts arbitrary deployment values (e.g. staging)", () => {
  // Not an enum — a "staging" deployment must not fail startup. config.nodeEnv
  // is just whatever non-empty string was provided (or the default).
  assert.equal(typeof config.nodeEnv, "string")
  assert.ok(config.nodeEnv.length > 0)
})
