import assert from "node:assert/strict"
import test from "node:test"
import { parseMemoryEmbeddingCachePayload } from "./embedding-cache-codec.js"

test("parseMemoryEmbeddingCachePayload: accepts finite numeric vectors", () => {
  assert.deepEqual(parseMemoryEmbeddingCachePayload("[0.1,-2,3]"), [0.1, -2, 3])
})

test("parseMemoryEmbeddingCachePayload: rejects absent or malformed JSON", () => {
  assert.equal(parseMemoryEmbeddingCachePayload(null), null)
  assert.equal(parseMemoryEmbeddingCachePayload(""), null)
  assert.equal(parseMemoryEmbeddingCachePayload("{not-json"), null)
})

test("parseMemoryEmbeddingCachePayload: rejects non-vector cache payloads", () => {
  assert.equal(parseMemoryEmbeddingCachePayload("{}"), null)
  assert.equal(parseMemoryEmbeddingCachePayload('"text"'), null)
  assert.equal(parseMemoryEmbeddingCachePayload("[]"), null)
  assert.equal(parseMemoryEmbeddingCachePayload('[1,"2",3]'), null)
  assert.equal(parseMemoryEmbeddingCachePayload("[1e999]"), null)
})
