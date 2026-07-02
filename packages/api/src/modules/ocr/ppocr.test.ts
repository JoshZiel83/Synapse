import { test, afterEach } from "node:test"
import assert from "node:assert/strict"

// Select ppocr BEFORE importing config (validated once at import). superRefine
// requires PPOCR_URL when OCR_PROVIDER=ppocr.
process.env.OCR_PROVIDER = "ppocr"
process.env.PPOCR_URL = "http://ppocr.test/"
process.env.PPOCR_TIER = "small"
process.env.PPOCR_TIMEOUT_MS = "5000"

const { ppocrProvider } = await import("./providers/ppocr.js")
const { resolveOcrProvider } = await import("./registry.js")
const { recognizeOcr } = await import("./index.js")

const BYTES = new Uint8Array([1, 2, 3, 4])
function req(sha: string) {
  return { sha256: sha, mimeType: "image/png", bytes: BYTES }
}
function sha(seed: string): string {
  return (seed + "0".repeat(64)).slice(0, 64)
}

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

test("registry resolves ppocr with tier-tagged provenance", () => {
  const provider = resolveOcrProvider()
  assert.equal(provider.key, "ppocr")
  assert.equal(provider.parserKey, "ppocr")
  assert.equal(provider.engineVersion, "PP-OCRv6-small")
  assert.equal(provider.isConfigured(), true)
})

test("ppocr adapter maps a successful response to ok+text+model", async () => {
  globalThis.fetch = (async () =>
    jsonResponse(200, {
      text: "  paddle \n text ",
      model: "PP-OCRv6_small",
    })) as typeof fetch
  const result = await ppocrProvider.recognize(req(sha("ok")))
  assert.equal(result.ok, true)
  assert.equal(result.text, "paddle text")
  assert.equal(result.provider, "ppocr")
  assert.equal(result.model, "PP-OCRv6_small")
})

test("ppocr adapter maps 503 (busy/loading) to retryable", async () => {
  globalThis.fetch = (async () =>
    jsonResponse(503, { error: "loading" })) as typeof fetch
  const result = await ppocrProvider.recognize(req(sha("loading")))
  assert.equal(result.ok, false)
  assert.equal(result.retryable, true)
})

test("ppocr adapter treats empty text as terminal", async () => {
  globalThis.fetch = (async () =>
    jsonResponse(200, { text: "" })) as typeof fetch
  const result = await ppocrProvider.recognize(req(sha("empty")))
  assert.equal(result.ok, false)
  assert.equal(result.retryable, false)
})

test("ppocr adapter never rejects on a network error", async () => {
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED")
  }) as typeof fetch
  const result = await ppocrProvider.recognize(req(sha("neterr")))
  assert.equal(result.ok, false)
  assert.equal(result.retryable, true)
})

test("facade routes to ppocr and caches success", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return jsonResponse(200, { text: "cached ppocr" })
  }) as typeof fetch
  const s = sha("facade")
  const first = await recognizeOcr(req(s))
  const second = await recognizeOcr(req(s))
  assert.equal(first.provider, "ppocr")
  assert.equal(second.text, "cached ppocr")
  assert.equal(calls, 1)
})
