import { test } from "node:test"
import assert from "node:assert/strict"

// EMBEDDING_PROVIDER unset => the active provider resolves to "none" (no boot gate
// trips). This file covers the pure select() branches independently of an active
// selection, mirroring modules/asr/registry.test.ts.
delete process.env.EMBEDDING_PROVIDER

const { selectEmbeddingProvider, resolveEmbeddingProvider } =
  await import("./registry.js")

test("select routes each known provider name", () => {
  assert.equal(selectEmbeddingProvider("local").key, "local")
  assert.equal(
    selectEmbeddingProvider("openai-compatible").key,
    "openai-compatible"
  )
  assert.equal(selectEmbeddingProvider("none").key, "none")
})

test("an unknown provider name is a loud skip → null provider", () => {
  const provider = selectEmbeddingProvider("totally-made-up")
  assert.equal(provider.key, "none")
  assert.equal(provider.isConfigured(), false)
})

test("resolve returns 'none' when EMBEDDING_PROVIDER is unset", () => {
  assert.equal(resolveEmbeddingProvider().key, "none")
})

test("engineVersion encodes the dimension (cache/space identity)", () => {
  // dimension is appended so a width change flips the identity → the boot guard +
  // caches partition by space. Default model bge-m3, default dim 1024.
  assert.match(selectEmbeddingProvider("local").engineVersion, /:\d+$/)
  assert.equal(selectEmbeddingProvider("local").dimension, 1024)
})
