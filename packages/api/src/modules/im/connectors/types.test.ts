import test from "node:test"
import assert from "node:assert/strict"
import { unwrapTypingAdapterResult } from "./types.js"
import type { TypingAdapter } from "../typing/controller.js"

const adapter: TypingAdapter = {
  start: async () => {},
  stop: async () => {},
}

test("unwrapTypingAdapterResult: null → null", () => {
  assert.equal(unwrapTypingAdapterResult(null), null)
})

test("unwrapTypingAdapterResult: bare TypingAdapter → wrap with no config", () => {
  const result = unwrapTypingAdapterResult(adapter)
  assert.ok(result)
  assert.strictEqual(result?.adapter, adapter)
  assert.equal(result?.config, undefined)
})

test("unwrapTypingAdapterResult: {adapter, config} passthrough", () => {
  const wrapped = { adapter, config: { heartbeatMs: 50_000 } }
  const result = unwrapTypingAdapterResult(wrapped)
  assert.ok(result)
  assert.strictEqual(result?.adapter, adapter)
  assert.deepEqual(result?.config, { heartbeatMs: 50_000 })
})

test("unwrapTypingAdapterResult: {adapter} without config", () => {
  const wrapped = { adapter }
  const result = unwrapTypingAdapterResult(wrapped)
  assert.ok(result)
  assert.strictEqual(result?.adapter, adapter)
  assert.equal(result?.config, undefined)
})
