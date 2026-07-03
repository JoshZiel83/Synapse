import { test, afterEach } from "node:test"
import assert from "node:assert/strict"

// Configure the embedding layer BEFORE importing config (validated once at import).
// Active provider = openai-compatible so the facade's dimension contract + batch
// splitting are exercised; the local adapter is configured too (URL present) so its
// wire mapping can be tested directly. EMBEDDING_DIMENSION=4 keeps hand-written test
// vectors small.
process.env.EMBEDDING_PROVIDER = "openai-compatible"
process.env.EMBEDDING_DIMENSION = "4"
process.env.EMBEDDING_OPENAI_BASE_URL = "https://embed.test/v1/"
process.env.EMBEDDING_OPENAI_API_KEY = "sk-test"
process.env.EMBEDDING_OPENAI_MODEL = "text-embedding-test"
process.env.EMBEDDING_OPENAI_MAX_BATCH = "2"
process.env.EMBEDDING_OPENAI_INPUT_ROLE_MODE = "jina-task"
process.env.EMBEDDING_LOCAL_URL = "http://embed.test/"
process.env.EMBEDDING_LOCAL_MODEL = "bge-m3"

const { selectEmbeddingProvider, resolveEmbeddingProvider } =
  await import("./registry.js")
const { localEmbeddingProvider } = await import("./providers/local.js")
const { openAiCompatibleProvider } =
  await import("./providers/openai-compatible.js")
const { embedQuery, embedPassages, getEmbeddingHealth } =
  await import("./index.js")

const DIM = 4

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** A distinct unit vector of width DIM (a single 1 in a rotating slot). */
function unit(seed: number): number[] {
  const v = new Array(DIM).fill(0)
  v[((seed % DIM) + DIM) % DIM] = 1
  return v
}

/** openai-shaped `{ data: [{ embedding, index }] }` for N rows. */
function openAiData(count: number, embeddingFor: (i: number) => number[]) {
  return {
    data: Array.from({ length: count }, (_, i) => ({
      embedding: embeddingFor(i),
      index: i,
    })),
  }
}

/** fetch stub that echoes one unit vector per input text (records request bodies). */
function echoStub(capture?: Array<Record<string, unknown>>): typeof fetch {
  return (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { input: string[] }
    capture?.push(body as unknown as Record<string, unknown>)
    return jsonResponse(200, openAiData(body.input.length, unit))
  }) as unknown as typeof fetch
}

// --- registry ---------------------------------------------------------------

test("registry resolves the configured provider", () => {
  const provider = resolveEmbeddingProvider()
  assert.equal(provider.key, "openai-compatible")
  assert.equal(provider.dimension, DIM)
  assert.equal(provider.isConfigured(), true)
  assert.equal(provider.engineVersion, `text-embedding-test:${DIM}`)
})

test("unknown/none providers resolve to the null provider (ok:false)", async () => {
  const none = selectEmbeddingProvider("none")
  const bogus = selectEmbeddingProvider("does-not-exist")
  assert.equal(none.key, "none")
  assert.equal(bogus.key, "none")
  assert.equal(none.isConfigured(), false)
  const result = await none.embed({ texts: ["x"], inputType: "query" })
  assert.equal(result.ok, false)
  assert.equal(result.retryable, false)
})

// --- openai-compatible adapter ----------------------------------------------

test("openai adapter extracts + reorders data rows by index", async () => {
  // Return rows out of order; the adapter must sort by `index`.
  globalThis.fetch = (async () =>
    jsonResponse(200, {
      data: [
        { embedding: unit(1), index: 1 },
        { embedding: unit(0), index: 0 },
      ],
    })) as unknown as typeof fetch
  const result = await openAiCompatibleProvider.embed({
    texts: ["a", "b"],
    inputType: "passage",
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.vectors[0], unit(0))
  assert.deepEqual(result.vectors[1], unit(1))
})

test("openai adapter maps inputType per role mode (jina task)", async () => {
  const capture: Array<Record<string, unknown>> = []
  globalThis.fetch = echoStub(capture)
  await openAiCompatibleProvider.embed({ texts: ["q"], inputType: "query" })
  await openAiCompatibleProvider.embed({ texts: ["p"], inputType: "passage" })
  assert.equal(capture[0].task, "retrieval.query")
  assert.equal(capture[1].task, "retrieval.passage")
  // Auth header + model + encoding_format are always sent.
  assert.equal(capture[0].model, "text-embedding-test")
  assert.equal(capture[0].encoding_format, "float")
})

test("openai adapter declares maxBatch from config", () => {
  assert.equal(openAiCompatibleProvider.maxBatch, 2)
})

test("openai adapter classifies 503/429/5xx retryable, 4xx terminal", async () => {
  for (const status of [503, 429, 500]) {
    globalThis.fetch = (async () =>
      jsonResponse(status, {})) as unknown as typeof fetch
    const r = await openAiCompatibleProvider.embed({
      texts: ["x"],
      inputType: "query",
    })
    assert.equal(r.ok, false)
    assert.equal(r.retryable, true, `HTTP ${status} should be retryable`)
  }
  globalThis.fetch = (async () =>
    jsonResponse(400, {})) as unknown as typeof fetch
  const terminal = await openAiCompatibleProvider.embed({
    texts: ["x"],
    inputType: "query",
  })
  assert.equal(terminal.retryable, false)
})

test("openai adapter never rejects on a network error", async () => {
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED")
  }) as unknown as typeof fetch
  const r = await openAiCompatibleProvider.embed({
    texts: ["x"],
    inputType: "query",
  })
  assert.equal(r.ok, false)
  assert.equal(r.retryable, true)
  assert.match(r.error ?? "", /ECONNREFUSED/)
})

// --- local adapter (shared factory, different wire shape) --------------------

test("local adapter posts {texts,input_type} and reads {embeddings}", async () => {
  const capture: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body)
    capture.push(body)
    return jsonResponse(200, { embeddings: [unit(0), unit(1)], dim: DIM })
  }) as unknown as typeof fetch
  const result = await localEmbeddingProvider.embed({
    texts: ["a", "b"],
    inputType: "passage",
  })
  assert.equal(result.ok, true)
  assert.equal(result.vectors.length, 2)
  assert.deepEqual(capture[0].texts, ["a", "b"])
  assert.equal(capture[0].input_type, "passage")
  assert.equal(localEmbeddingProvider.engineVersion, `bge-m3:${DIM}`)
})

// --- facade: dimension contract ---------------------------------------------

test("facade rejects a wrong-dimension vector as terminal", async () => {
  globalThis.fetch = (async () =>
    jsonResponse(200, {
      data: [{ embedding: [1, 0, 0], index: 0 }], // 3-d, expected 4-d
    })) as unknown as typeof fetch
  const result = await embedQuery("hello")
  assert.equal(result.ok, false)
  assert.equal(result.retryable, false)
  assert.match(result.error ?? "", /vector|dimension/i)
})

test("adapter rejects a row with a non-numeric element (no coercion to 0/1)", async () => {
  // A buggy build padding a correct-WIDTH row with null must be terminal, not
  // silently repaired to 0 and persisted as a corrupt vector.
  globalThis.fetch = (async () =>
    jsonResponse(200, {
      data: [{ embedding: [1, 0, 0, null], index: 0 }],
    })) as unknown as typeof fetch
  const result = await openAiCompatibleProvider.embed({
    texts: ["x"],
    inputType: "query",
  })
  assert.equal(result.ok, false)
  assert.equal(result.retryable, false)
  assert.match(result.error ?? "", /shape/i)
})

test("facade rejects a zero-norm vector as terminal (would NaN under cosine)", async () => {
  globalThis.fetch = (async () =>
    jsonResponse(200, {
      data: [{ embedding: [0, 0, 0, 0], index: 0 }],
    })) as unknown as typeof fetch
  const result = await embedQuery("hello")
  assert.equal(result.ok, false)
  assert.equal(result.retryable, false)
})

test("facade rejects a row-count mismatch as terminal", async () => {
  globalThis.fetch = (async () =>
    jsonResponse(200, openAiData(1, unit))) as unknown as typeof fetch
  const result = await embedPassages(["a", "b"])
  assert.equal(result.ok, false)
  assert.equal(result.retryable, false)
})

test("facade L2-normalizes a non-unit vector", async () => {
  globalThis.fetch = (async () =>
    jsonResponse(200, {
      data: [{ embedding: [3, 0, 0, 0], index: 0 }],
    })) as unknown as typeof fetch
  const result = await embedQuery("hello")
  assert.equal(result.ok, true)
  const norm = Math.hypot(...result.vectors[0])
  assert.ok(Math.abs(norm - 1) < 1e-6, `expected unit norm, got ${norm}`)
  assert.ok(Math.abs(result.vectors[0][0] - 1) < 1e-6)
})

// --- facade: empty-text filtering + batch splitting -------------------------

test("facade filters empty texts to [] slots without dispatching them", async () => {
  const capture: Array<Record<string, unknown>> = []
  globalThis.fetch = echoStub(capture)
  const result = await embedPassages(["hello", "   ", "world"])
  assert.equal(result.ok, true)
  assert.equal(result.vectors[0].length, DIM)
  assert.equal(result.vectors[1].length, 0, "empty slot stays []")
  assert.equal(result.vectors[2].length, DIM)
  // Only the 2 non-empty texts were dispatched (across split batches).
  const dispatched = capture.flatMap((b) => b.input as string[])
  assert.deepEqual(dispatched, ["hello", "world"])
})

test("facade splits a batch larger than provider.maxBatch and reassembles in order", async () => {
  const capture: Array<Record<string, unknown>> = []
  globalThis.fetch = echoStub(capture)
  const result = await embedPassages(["t0", "t1", "t2"]) // maxBatch=2 → [2,1]
  assert.equal(result.ok, true)
  assert.equal(result.vectors.length, 3)
  assert.equal(capture.length, 2, "3 texts / maxBatch 2 → 2 requests")
  assert.deepEqual(capture[0].input, ["t0", "t1"])
  assert.deepEqual(capture[1].input, ["t2"])
  // reassembled in order: unit(0),unit(1) from batch 1, unit(0) from batch 2
  assert.deepEqual(result.vectors[0], unit(0))
  assert.deepEqual(result.vectors[1], unit(1))
  assert.deepEqual(result.vectors[2], unit(0))
})

test("facade short-circuits a split on the first failing sub-batch", async () => {
  let calls = 0
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    calls += 1
    if (calls === 1) {
      const body = JSON.parse(init.body) as { input: string[] }
      return jsonResponse(200, openAiData(body.input.length, unit))
    }
    return jsonResponse(500, {})
  }) as unknown as typeof fetch
  const result = await embedPassages(["t0", "t1", "t2"])
  assert.equal(result.ok, false)
  assert.equal(result.retryable, true)
})

test("empty query is a terminal failure (caller degrades to lexical)", async () => {
  const result = await embedQuery("   ")
  assert.equal(result.ok, false)
  assert.equal(result.retryable, false)
})

// --- health snapshot --------------------------------------------------------

test("health snapshot reports the active provider + dimension", () => {
  const health = getEmbeddingHealth()
  assert.equal(health.provider, "openai-compatible")
  assert.equal(health.dimension, DIM)
  assert.equal(health.configured, true)
})
