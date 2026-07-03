// modules/embedding/ — the embedding (text → dense vector) abstraction layer.
//
// The api core bundles NO embedding engine. It selects a provider by env
// (config.embedding.provider) and calls the facade (index.ts). Every provider —
// the local bge-m3 sidecar and, later, cloud vendors behind the generic
// openai-compatible adapter — is an out-of-process adapter behind this interface.
// Modelled on modules/transcription/ + modules/ocr/.
//
// This layer is NOT memory-specific: memory is the first consumer, future
// intelligent-retrieval is the second. It owns exactly ONE transform — batch text
// → dense vectors, with a query|passage role hint and a declared output dimension.
// It does NOT own chunking, search-text building, the pgvector `[..]`↔`::vector`
// (de)serialization, or the query/passage caches — those stay memory-specific.

/** Asymmetric-search role hint. Each provider maps it to its own convention,
 *  modelled INSIDE the provider (never a shared normalizer): symmetric models
 *  ignore it (bge-m3, and the OpenAI-compat endpoints of DashScope/Zhipu/
 *  SiliconFlow); Jina honors a top-level `task`; a future native Cohere/DashScope
 *  seam would use input_type / text_type. */
export type EmbeddingInputType = "query" | "passage"

/** Public input to the facade (batch-first). */
export interface EmbedInput {
  readonly texts: readonly string[]
  readonly inputType: EmbeddingInputType
}

/**
 * The normalized embedding result every adapter maps INTO. On `ok:true`, the
 * facade has guaranteed `vectors.length === texts.length`, every row length ===
 * the active provider's `dimension`, every value finite, and every row unit-norm
 * (L2). On `ok:false`, `vectors` is `[]`.
 *
 * `retryable` classifies a FAILURE: true = transient (sidecar down / timeout /
 * 5xx / 429) → the caller may retry and the facade must NOT cache it; false =
 * deterministic (4xx / not configured / wrong shape) → terminal.
 */
export interface EmbeddingResult {
  readonly ok: boolean
  readonly vectors: number[][]
  readonly provider: string
  readonly engineVersion: string
  readonly model?: string
  readonly retryable?: boolean
  readonly error?: string
}

export interface EmbeddingProvider {
  /** stable id, e.g. "local" | "openai-compatible" | "none" */
  readonly key: string
  /** cache-key component + provenance/log field. Encodes the model AND its output
   *  width (e.g. "bge-m3:1024") so the "one active embedding space" identity is a
   *  single string: two providers serving the SAME model+dim (local bge-m3 vs a
   *  cloud bge-m3) share it — swapping between them is safe — while any model or
   *  dim change flips it, which the boot guard uses to refuse a corrupting swap. */
  readonly engineVersion: string
  /** DECLARED output width. The one field OCR/transcription lack; load-bearing —
   *  the facade rejects any row whose length !== this, and the boot guard asserts
   *  it equals the live pgvector column typmod. */
  readonly dimension: number
  /** Max texts a single provider request accepts, if the vendor caps it below an
   *  arbitrary batch (DashScope compat ≈ 10, Gemini-compat = 1). The facade splits
   *  a larger batch into safe sub-batches and reassembles in order. Omitted (local
   *  sidecar) = no cap. Concrete field ONLY because a shipped provider needs it. */
  readonly maxBatch?: number
  /** true only when the env needed to reach this provider is present. */
  isConfigured(): boolean
  /** MUST always resolve (never reject); returns ok:false on any error. The
   *  facade re-validates shape/dimension/finite/norm before trusting ok:true. */
  embed(input: EmbedInput): Promise<EmbeddingResult>
}
