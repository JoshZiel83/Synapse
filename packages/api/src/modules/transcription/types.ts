// modules/transcription/ — the ASR (batch/file speech-to-text) abstraction layer.
//
// The api core bundles NO concrete ASR engine. It selects a provider by env
// (config.transcription.provider) and calls the ONE facade `transcribe`
// (index.ts). Every provider — the sherpa-onnx sidecar and, later, cloud vendors
// — is an out-of-process adapter behind this interface. Sibling of modules/ocr/;
// DISTINCT from the realtime WebSocket dictation gateway in modules/asr/ (a
// different modality with its own vendor-specific protocol).

/** Public input to the facade. `bytes` is optional: the facade loads them from
 *  the content-addressed store by `sha256` when the caller doesn't already have
 *  them. `sha256` is the cache key. */
export interface TranscribeInput {
  readonly sha256: string
  readonly mimeType: string
  readonly bytes?: Uint8Array
}

/** What an adapter receives — `bytes` is guaranteed present (the facade loads
 *  them before dispatch), so adapters never touch the content store. */
export interface TranscriptionRequest {
  readonly sha256: string
  readonly mimeType: string
  readonly bytes: Uint8Array
}

/**
 * The normalized transcription result every adapter maps INTO. `text` is the
 * only field guaranteed on success (`ok:true` ⇒ non-empty `text`). Richer fields
 * (segments, words, timestamps, confidence, detected language, and the untouched
 * vendor payload) are intentionally deferred until a real consumer shapes them —
 * added back to this contract then, not carried speculatively. Likewise the
 * async/staging seam a job-based cloud vendor (AWS Transcribe / 讯飞转写) needs is
 * documented in the plan but NOT modelled here: the sole v1 consumer is a
 * synchronous inline call, so an async provider will extend this contract when
 * it actually lands rather than pay for unexercised generality now.
 *
 * `retryable` classifies a FAILURE: true = transient (sidecar down / timeout /
 * 5xx) → the caller may retry and the facade must NOT cache it; false =
 * deterministic (no speech / 4xx / not configured) → terminal, cacheable.
 */
export interface TranscriptionResult {
  readonly ok: boolean
  readonly text: string
  readonly provider: string
  readonly engineVersion: string
  readonly model?: string
  readonly retryable?: boolean
  readonly error?: string
}

export interface TranscriptionProvider {
  /** stable id, e.g. "sherpa" | "none" */
  readonly key: string
  /** cache-key component + log/provenance field. Encodes the engine AND its
   *  active model so a model swap can't serve a stale transcript for the same
   *  sha256. (Audio has no file_parse_runs row, so this is not a DB parser_version
   *  — it is purely the in-process cache key + a log field.) */
  readonly engineVersion: string
  /** true only when the env needed to reach this engine is present */
  isConfigured(): boolean
  /** MUST always resolve (never reject); returns ok:false on any error. */
  transcribe(req: TranscriptionRequest): Promise<TranscriptionResult>
}
