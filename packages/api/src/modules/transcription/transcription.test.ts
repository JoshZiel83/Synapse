import { test, afterEach } from "node:test"
import assert from "node:assert/strict"

// Configure the transcription layer BEFORE importing config (validated once at
// import). TRANSCRIPTION_PROVIDER=sherpa requires TRANSCRIPTION_SHERPA_URL
// (superRefine), so set both.
process.env.TRANSCRIPTION_PROVIDER = "sherpa"
process.env.TRANSCRIPTION_SHERPA_URL = "http://sherpa-asr.test/"
process.env.TRANSCRIPTION_SHERPA_TIMEOUT_MS = "5000"

const { normalizeTranscript } = await import("./normalize.js")
const { sherpaProvider } = await import("./providers/sherpa.js")
const { resolveTranscriptionProvider } = await import("./registry.js")
const { transcribe } = await import("./index.js")

const BYTES = new Uint8Array([1, 2, 3, 4])
function req(sha: string) {
  return { sha256: sha, mimeType: "audio/ogg", bytes: BYTES }
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

test("normalizeTranscript trims, collapses whitespace, caps length", () => {
  assert.equal(normalizeTranscript("  hello \n\t world  "), "hello world")
  assert.equal(normalizeTranscript("x".repeat(5000)).length, 4000)
  assert.equal(normalizeTranscript("   "), "")
})

// --- registry ---------------------------------------------------------------

test("registry resolves the configured provider", () => {
  const provider = resolveTranscriptionProvider()
  assert.equal(provider.key, "sherpa")
  assert.equal(provider.engineVersion, "sherpa-onnx:sensevoice-small")
  assert.equal(provider.isConfigured(), true)
})

// --- sherpa adapter ---------------------------------------------------------

test("sherpa adapter maps a successful response to ok+text+model", async () => {
  globalThis.fetch = (async () =>
    jsonResponse(200, { text: "  hello \n world " })) as typeof fetch
  const result = await sherpaProvider.transcribe(req(sha("ok")))
  assert.equal(result.ok, true)
  assert.equal(result.text, "hello world")
  assert.equal(result.provider, "sherpa")
  assert.equal(result.engineVersion, "sherpa-onnx:sensevoice-small")
  assert.equal(result.model, "sensevoice-small")
})

test("sherpa adapter treats empty text as terminal (non-retryable)", async () => {
  globalThis.fetch = (async () =>
    jsonResponse(200, { text: "   " })) as typeof fetch
  const result = await sherpaProvider.transcribe(req(sha("empty")))
  assert.equal(result.ok, false)
  assert.equal(result.retryable, false)
  assert.match(result.error ?? "", /no text/i)
})

test("sherpa adapter marks 503 and 5xx retryable, 4xx terminal", async () => {
  globalThis.fetch = (async () => jsonResponse(503, {})) as typeof fetch
  assert.equal(
    (await sherpaProvider.transcribe(req(sha("busy")))).retryable,
    true
  )

  globalThis.fetch = (async () => jsonResponse(500, {})) as typeof fetch
  assert.equal(
    (await sherpaProvider.transcribe(req(sha("5xx")))).retryable,
    true
  )

  globalThis.fetch = (async () => jsonResponse(400, {})) as typeof fetch
  assert.equal(
    (await sherpaProvider.transcribe(req(sha("4xx")))).retryable,
    false
  )
})

test("sherpa adapter never rejects on a network error", async () => {
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED")
  }) as typeof fetch
  const result = await sherpaProvider.transcribe(req(sha("neterr")))
  assert.equal(result.ok, false)
  assert.equal(result.retryable, true)
  assert.match(result.error ?? "", /ECONNREFUSED/)
})

// --- facade cache policy ----------------------------------------------------

test("facade caches successes (single-flight, one upstream call)", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return jsonResponse(200, { text: "cached transcript" })
  }) as typeof fetch

  const s = sha("cache-success")
  const first = await transcribe(req(s))
  const second = await transcribe(req(s))
  assert.equal(first.ok, true)
  assert.equal(second.text, "cached transcript")
  assert.equal(calls, 1, "second call should be served from cache")
})

test("facade does NOT cache transient (retryable) failures", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return jsonResponse(503, {})
  }) as typeof fetch

  const s = sha("cache-retryable")
  const first = await transcribe(req(s))
  const second = await transcribe(req(s))
  assert.equal(first.ok, false)
  assert.equal(second.ok, false)
  assert.equal(calls, 2, "a retryable failure must be re-attempted, not cached")
})
