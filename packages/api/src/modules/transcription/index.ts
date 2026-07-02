// Transcription facade — the ONE function the api core calls for speech-to-text.
//
// Owns: loading bytes from the content-addressed store (when the caller didn't
// pass them), an LRU single-flight cache, and the never-reject guarantee.
//
// Cache policy (identical to modules/ocr): cache successes AND deterministic
// (non-retryable) failures for 1h; NEVER persist a transient (retryable) failure
// — otherwise one sidecar blip poisons an audio clip for an hour. The in-flight
// Promise is cached so concurrent callers share a single transcription run per
// sha256.

import { LRUCache } from "lru-cache"
import { createLogger } from "../../infrastructure/logger/index.js"
import { readContentBufferBySha } from "../files/service.js"
import { resolveTranscriptionProvider } from "./registry.js"
import type {
  TranscribeInput,
  TranscriptionProvider,
  TranscriptionResult,
} from "./types.js"

const log = createLogger("transcription.facade")

const cache = new LRUCache<string, Promise<TranscriptionResult>>({
  max: 500,
  ttl: 60 * 60 * 1000, // 1h
})

async function runTranscribe(
  provider: TranscriptionProvider,
  input: TranscribeInput
): Promise<TranscriptionResult> {
  let bytes = input.bytes
  if (!bytes) {
    const buffer = await readContentBufferBySha(input.sha256)
    if (!buffer) {
      // readContentBufferBySha returns null for BOTH a genuinely-missing blob
      // AND a transient backend error — indistinguishable here. Mark it
      // retryable so this failure is NEVER cached: otherwise a one-off store
      // blip would poison the sha-keyed cache for the full TTL.
      return {
        ok: false,
        text: "",
        provider: provider.key,
        engineVersion: provider.engineVersion,
        error: "audio content not found",
        retryable: true,
      }
    }
    bytes = buffer
  }

  try {
    return await provider.transcribe({
      sha256: input.sha256,
      mimeType: input.mimeType,
      bytes,
    })
  } catch (err) {
    // Adapters must never reject; enforce it at the facade boundary too so a
    // provider bug can't crash the un-guarded outbound-LLM audio-fallback path.
    log.error(
      { err, provider: provider.key },
      "transcription provider threw (contract violation)"
    )
    return {
      ok: false,
      text: "",
      provider: provider.key,
      engineVersion: provider.engineVersion,
      error:
        err instanceof Error ? err.message : "transcription provider threw",
      retryable: true,
    }
  }
}

/** Transcribe an audio blob to text. Always resolves (never rejects). */
export async function transcribe(
  input: TranscribeInput
): Promise<TranscriptionResult> {
  const provider = resolveTranscriptionProvider()
  const cacheKey = `${provider.key}:${provider.engineVersion}:${input.sha256}`

  const cached = cache.get(cacheKey)
  if (cached) return cached

  const pending = runTranscribe(provider, input)
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

export { resolveTranscriptionProvider } from "./registry.js"
export type {
  TranscriptionProvider,
  TranscriptionResult,
  TranscriptionRequest,
  TranscribeInput,
} from "./types.js"
