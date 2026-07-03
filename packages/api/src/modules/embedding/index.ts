// Embedding facade — the functions the api core calls to turn text into dense
// vectors. Owns the never-reject guarantee, the authoritative dimension/finite/norm
// contract (enforced ONCE here so a wrong-width vector can never reach `::vector`),
// empty-text filtering, and provider maxBatch splitting.
//
// Two entry points, ASYMMETRIC by design (unlike the single-mode OCR/transcription
// facades — do NOT "consistency-fix" them into one):
//   - embedQuery(text)      → the recall hot path. Failure degrades to lexical.
//   - embedPassages(texts)  → the index/BullMQ path. The caller reads ok/retryable
//                             and must never persist a bad vector.
// There is NO facade-level cache: the query path is cached durably in Redis by the
// memory consumer (embedding-cache.ts) and passages in Postgres (memory_embedding_
// cache), both keyed by provider.engineVersion. A second in-process LRU here would
// just double-cache the same thing.

import { createLogger } from "../../infrastructure/logger/index.js"
import { resolveEmbeddingProvider } from "./registry.js"
import type {
  EmbeddingInputType,
  EmbeddingProvider,
  EmbeddingResult,
} from "./types.js"

const log = createLogger("embedding.facade")

// Last observed embed outcome, for the non-blocking health snapshot (never a
// synchronous provider round-trip inside /health).
let lastOutcome: { ok: boolean; at: number; error?: string } | null = null

function recordOutcome(result: EmbeddingResult): void {
  lastOutcome = {
    ok: result.ok,
    at: Date.now(),
    error: result.ok ? undefined : result.error,
  }
}

function fail(
  provider: EmbeddingProvider,
  error: string,
  retryable: boolean
): EmbeddingResult {
  return {
    ok: false,
    vectors: [],
    provider: provider.key,
    engineVersion: provider.engineVersion,
    retryable,
    error,
  }
}

/** Call provider.embed with the never-reject guarantee enforced at the boundary
 *  (a thrown adapter becomes a retryable failure). */
async function callProvider(
  provider: EmbeddingProvider,
  texts: readonly string[],
  inputType: EmbeddingInputType
): Promise<EmbeddingResult> {
  try {
    return await provider.embed({ texts, inputType })
  } catch (err) {
    log.error(
      { err, provider: provider.key },
      "embedding provider threw (contract violation)"
    )
    return fail(
      provider,
      err instanceof Error ? err.message : "embedding provider threw",
      true
    )
  }
}

/** The authoritative dimension contract: on ok, assert N-in/N-out, each row is
 *  exactly provider.dimension wide, finite, and non-zero-norm, then L2-normalize
 *  (idempotent). `texts` here are the non-empty dispatch set. */
function validate(
  provider: EmbeddingProvider,
  texts: readonly string[],
  raw: EmbeddingResult
): EmbeddingResult {
  if (!raw.ok) return raw
  if (raw.vectors.length !== texts.length) {
    return fail(
      provider,
      `embedding provider returned ${raw.vectors.length} vectors for ${texts.length} texts`,
      false
    )
  }
  const normalized: number[][] = []
  for (const row of raw.vectors) {
    if (row.length !== provider.dimension) {
      return fail(
        provider,
        `embedding provider returned a ${row.length}-d vector, expected ${provider.dimension}`,
        false
      )
    }
    let sumSq = 0
    for (const value of row) {
      if (!Number.isFinite(value)) {
        return fail(provider, "embedding contained a non-finite value", false)
      }
      sumSq += value * value
    }
    const norm = Math.sqrt(sumSq)
    if (norm < 1e-12) {
      return fail(provider, "embedding was a zero vector", false)
    }
    normalized.push(
      Math.abs(norm - 1) < 1e-6 ? row : row.map((value) => value / norm)
    )
  }
  return {
    ok: true,
    vectors: normalized,
    provider: raw.provider,
    engineVersion: raw.engineVersion,
    model: raw.model,
  }
}

function subBatches<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size))
  }
  return batches
}

/** Embed a non-empty dispatch set, splitting into provider.maxBatch sub-batches
 *  and reassembling in order. Any sub-batch failure short-circuits (its
 *  retryable classification is preserved) — no partial vectors. */
async function embedDispatch(
  provider: EmbeddingProvider,
  texts: readonly string[],
  inputType: EmbeddingInputType
): Promise<EmbeddingResult> {
  const cap = provider.maxBatch && provider.maxBatch > 0 ? provider.maxBatch : 0
  if (cap === 0 || texts.length <= cap) {
    return validate(
      provider,
      texts,
      await callProvider(provider, texts, inputType)
    )
  }
  const all: number[][] = []
  let model: string | undefined
  for (const chunk of subBatches(texts, cap)) {
    const result = validate(
      provider,
      chunk,
      await callProvider(provider, chunk, inputType)
    )
    if (!result.ok) return result
    all.push(...result.vectors)
    model ??= result.model
  }
  return {
    ok: true,
    vectors: all,
    provider: provider.key,
    engineVersion: provider.engineVersion,
    model,
  }
}

/**
 * Embed a single query text. Always resolves. On ok, `vectors[0]` is the query
 * vector. An empty query is a terminal (non-retryable) failure the caller treats
 * as "no vector → lexical-only".
 */
export async function embedQuery(text: string): Promise<EmbeddingResult> {
  const provider = resolveEmbeddingProvider()
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return fail(provider, "empty query text", false)
  }
  const result = await embedDispatch(provider, [trimmed], "query")
  recordOutcome(result)
  return result
}

/**
 * Embed a batch of passage texts for indexing. Always resolves. On ok,
 * `vectors[i]` is the unit vector for `texts[i]`, EXCEPT an empty/whitespace input
 * yields an empty row `[]` (the caller writes NULL for it) — so one empty chunk
 * can never 400 a whole cloud batch. The caller MUST read ok/retryable (see
 * modules/memory/indexing.ts): never persist a vector on a failed result.
 */
export async function embedPassages(
  texts: readonly string[]
): Promise<EmbeddingResult> {
  const provider = resolveEmbeddingProvider()

  const dispatchTexts: string[] = []
  const dispatchIndex: number[] = []
  texts.forEach((text, index) => {
    if ((text ?? "").trim()) {
      dispatchTexts.push(text)
      dispatchIndex.push(index)
    }
  })

  if (dispatchTexts.length === 0) {
    // Nothing embeddable → success with all-empty rows (caller writes NULLs).
    return {
      ok: true,
      vectors: texts.map(() => []),
      provider: provider.key,
      engineVersion: provider.engineVersion,
    }
  }

  const result = await embedDispatch(provider, dispatchTexts, "passage")
  recordOutcome(result)
  if (!result.ok) return result

  // Re-expand to original positions; empty-input slots stay `[]`.
  const vectors: number[][] = texts.map(() => [])
  dispatchIndex.forEach((originalIndex, k) => {
    vectors[originalIndex] = result.vectors[k]
  })
  return {
    ok: true,
    vectors,
    provider: provider.key,
    engineVersion: provider.engineVersion,
    model: result.model,
  }
}

export interface EmbeddingHealth {
  readonly provider: string
  readonly engineVersion: string
  readonly dimension: number
  readonly configured: boolean
  /** true = disabled-by-design (provider none) OR last embed succeeded; used for
   *  the /health aggregate WITHOUT a synchronous provider probe. Embedding is kept
   *  OUT of the hard `degraded` gate (memory degrades to lexical), so this is
   *  informational. */
  readonly ready: boolean
  readonly lastEmbedOk: boolean | null
  readonly lastError: string | null
}

/** Non-blocking health snapshot from the last observed outcome (never a live
 *  round-trip). For `none` the provider is disabled-by-design → ready:true. */
export function getEmbeddingHealth(): EmbeddingHealth {
  const provider = resolveEmbeddingProvider()
  const configured = provider.isConfigured()
  const lastEmbedOk = lastOutcome ? lastOutcome.ok : null
  const ready = provider.key === "none" ? true : lastEmbedOk !== false
  return {
    provider: provider.key,
    engineVersion: provider.engineVersion,
    dimension: provider.dimension,
    configured,
    ready,
    lastEmbedOk,
    lastError: lastOutcome?.error ?? null,
  }
}

/** Fire-and-forget warmup: probe the local sidecar so it loads its model + the
 *  health snapshot reflects reachability. No-op for `none` (disabled) and cloud
 *  (avoid spending on a boot canary; first real embed populates the snapshot). */
export async function warmEmbeddingProvider(): Promise<void> {
  const provider = resolveEmbeddingProvider()
  if (provider.key !== "local" || !provider.isConfigured()) return
  const result = await embedQuery("warmup")
  if (!result.ok) {
    log.warn(
      { error: result.error, provider: provider.key },
      "embedding warmup probe failed (memory will run lexical-only until it recovers)"
    )
  }
}

export { resolveEmbeddingProvider } from "./registry.js"
export type {
  EmbeddingProvider,
  EmbeddingResult,
  EmbedInput,
  EmbeddingInputType,
} from "./types.js"
