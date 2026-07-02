// OCR facade — the ONE function the api core calls for OCR.
//
// Owns: loading bytes from the content-addressed store (when the caller didn't
// pass them), an LRU single-flight cache, and the never-reject guarantee.
//
// Cache policy: cache successes AND deterministic (non-retryable) failures for
// 1h; NEVER persist a transient (retryable) failure — otherwise one sidecar
// blip poisons an image for an hour. The in-flight Promise is cached so
// concurrent callers (parse pipeline + AI image-fallback) share a single OCR
// run per sha256.

import { LRUCache } from "lru-cache"
import { createLogger } from "../../infrastructure/logger/index.js"
import { readContentBufferBySha } from "../files/service.js"
import { resolveOcrProvider } from "./registry.js"
import type { OcrProvider, OcrResult, RecognizeOcrInput } from "./types.js"

const log = createLogger("ocr.registry")

const cache = new LRUCache<string, Promise<OcrResult>>({
  max: 500,
  ttl: 60 * 60 * 1000, // 1h
})

async function runRecognize(
  provider: OcrProvider,
  input: RecognizeOcrInput
): Promise<OcrResult> {
  let bytes = input.bytes
  if (!bytes) {
    const buffer = await readContentBufferBySha(input.sha256)
    if (!buffer) {
      // readContentBufferBySha returns null for BOTH a genuinely-missing blob
      // AND a transient backend error — indistinguishable here. Mark it
      // retryable so this failure is NEVER cached: otherwise a no-bytes caller
      // (the AI image-fallback path) that hits a transient store blip would
      // poison the sha-keyed cache and make a later with-bytes caller (the parse
      // pipeline, which passes bytes) fail an image that would OCR fine.
      return {
        ok: false,
        text: "",
        provider: provider.key,
        engineVersion: provider.engineVersion,
        error: "image content not found",
        retryable: true,
      }
    }
    bytes = buffer
  }

  try {
    return await provider.recognize({
      sha256: input.sha256,
      mimeType: input.mimeType,
      bytes,
    })
  } catch (err) {
    // Adapters must never reject; enforce it at the facade boundary too so a
    // provider bug can't crash the un-guarded AI image-fallback path.
    log.error(
      { err, provider: provider.key },
      "OCR provider threw (contract violation)"
    )
    return {
      ok: false,
      text: "",
      provider: provider.key,
      engineVersion: provider.engineVersion,
      error: err instanceof Error ? err.message : "OCR provider threw",
      retryable: true,
    }
  }
}

/** Recognize text in an image. Always resolves (never rejects). */
export async function recognizeOcr(
  input: RecognizeOcrInput
): Promise<OcrResult> {
  const provider = resolveOcrProvider()
  const cacheKey = `${provider.key}:${provider.engineVersion}:${input.sha256}`

  const cached = cache.get(cacheKey)
  if (cached) return cached

  const pending = runRecognize(provider, input)
  cache.set(cacheKey, pending)

  const result = await pending
  // Evict transient failures so the next caller retries instead of being served
  // a cached blip for the full TTL. Successes + deterministic failures persist.
  // Compare-and-delete: only evict OUR entry, never a concurrent caller's freshly
  // repopulated one (which could have raced in during the await above).
  if (!result.ok && result.retryable && cache.get(cacheKey) === pending) {
    cache.delete(cacheKey)
  }
  return result
}

export { resolveOcrProvider } from "./registry.js"
export type {
  OcrProvider,
  OcrResult,
  OcrProviderRequest,
  RecognizeOcrInput,
} from "./types.js"
