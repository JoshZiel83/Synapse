import { test, afterEach } from "node:test"
import assert from "node:assert/strict"

// Configure the OCR layer BEFORE importing config (validated once at import).
// OCR_PROVIDER=tesseract requires TESSERACT_URL (superRefine), so set both.
process.env.OCR_PROVIDER = "tesseract"
process.env.TESSERACT_URL = "http://tesseract-ocr.test/"
process.env.TESSERACT_LANGS = "eng"
process.env.TESSERACT_TIMEOUT_MS = "5000"

const { normalizeOcrText } = await import("./normalize.js")
const { tesseractProvider } = await import("./providers/tesseract.js")
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

// --- normalize --------------------------------------------------------------

test("normalizeOcrText trims, collapses whitespace, caps length", () => {
  assert.equal(normalizeOcrText("  hello \n\t world  "), "hello world")
  assert.equal(normalizeOcrText("x".repeat(5000)).length, 4000)
  assert.equal(normalizeOcrText("   "), "")
})

// --- registry ---------------------------------------------------------------

test("registry resolves the configured provider", () => {
  const provider = resolveOcrProvider()
  assert.equal(provider.key, "tesseract")
  assert.equal(provider.parserKey, "tesseract_ocr")
  assert.equal(provider.engineVersion, "7")
  assert.equal(provider.isConfigured(), true)
})

// --- tesseract adapter ------------------------------------------------------

test("tesseract adapter maps a successful response to ok+text", async () => {
  globalThis.fetch = (async () =>
    jsonResponse(200, { text: "  hello \n world " })) as typeof fetch
  const result = await tesseractProvider.recognize(req(sha("ok")))
  assert.equal(result.ok, true)
  assert.equal(result.text, "hello world")
  assert.equal(result.provider, "tesseract")
  assert.equal(result.engineVersion, "7")
})

test("tesseract adapter treats empty text as terminal (non-retryable)", async () => {
  globalThis.fetch = (async () =>
    jsonResponse(200, { text: "   " })) as typeof fetch
  const result = await tesseractProvider.recognize(req(sha("empty")))
  assert.equal(result.ok, false)
  assert.equal(result.retryable, false)
  assert.match(result.error ?? "", /no text/i)
})

test("tesseract adapter marks 503 and 5xx retryable, 4xx terminal", async () => {
  globalThis.fetch = (async () => jsonResponse(503, {})) as typeof fetch
  assert.equal(
    (await tesseractProvider.recognize(req(sha("busy")))).retryable,
    true
  )

  globalThis.fetch = (async () => jsonResponse(500, {})) as typeof fetch
  assert.equal(
    (await tesseractProvider.recognize(req(sha("5xx")))).retryable,
    true
  )

  globalThis.fetch = (async () => jsonResponse(400, {})) as typeof fetch
  assert.equal(
    (await tesseractProvider.recognize(req(sha("4xx")))).retryable,
    false
  )
})

test("tesseract adapter never rejects on a network error", async () => {
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED")
  }) as typeof fetch
  const result = await tesseractProvider.recognize(req(sha("neterr")))
  assert.equal(result.ok, false)
  assert.equal(result.retryable, true)
  assert.match(result.error ?? "", /ECONNREFUSED/)
})

// --- facade cache policy ----------------------------------------------------

test("facade caches successes (single-flight, one upstream call)", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return jsonResponse(200, { text: "cached text" })
  }) as typeof fetch

  const s = sha("cache-success")
  const first = await recognizeOcr(req(s))
  const second = await recognizeOcr(req(s))
  assert.equal(first.ok, true)
  assert.equal(second.text, "cached text")
  assert.equal(calls, 1, "second call should be served from cache")
})

test("facade does NOT cache transient (retryable) failures", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return jsonResponse(503, {})
  }) as typeof fetch

  const s = sha("cache-retryable")
  const first = await recognizeOcr(req(s))
  const second = await recognizeOcr(req(s))
  assert.equal(first.ok, false)
  assert.equal(second.ok, false)
  assert.equal(calls, 2, "a retryable failure must be re-attempted, not cached")
})
