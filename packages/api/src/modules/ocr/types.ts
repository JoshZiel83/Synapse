// modules/ocr/ — the OCR abstraction layer.
//
// The api core bundles NO concrete OCR engine. It selects a provider by env
// (config.ocr.provider) and calls the ONE facade `recognizeOcr` (index.ts).
// Every provider — tesseract sidecar, PP-OCR sidecar, cloud vendors — is an
// out-of-process adapter behind this interface. Modelled on modules/asr/.

/** Public input to the facade. `bytes` is optional: the facade loads them from
 *  the content-addressed store by `sha256` when the caller doesn't already have
 *  them. `sha256` is the cache key (and the future cloud-staging handle). */
export interface RecognizeOcrInput {
  readonly sha256: string
  readonly mimeType: string
  readonly bytes?: Uint8Array
}

/** What an adapter receives — `bytes` is guaranteed present (the facade loads
 *  them before dispatch), so adapters never touch the content store. */
export interface OcrProviderRequest {
  readonly sha256: string
  readonly mimeType: string
  readonly bytes: Uint8Array
}

/**
 * The normalized OCR result every adapter maps INTO. `text` is the only field
 * guaranteed on success (`ok:true` ⇒ non-empty `text`). Richer fields (lines,
 * bbox, confidence, tables, and the untouched vendor payload) are intentionally
 * deferred until a real consumer shapes them — added back to this contract then,
 * not carried speculatively.
 *
 * `retryable` classifies a FAILURE: true = transient (sidecar down / timeout /
 * 5xx) → the parse pipeline may retry and the facade must NOT cache it; false =
 * deterministic (no text found / 4xx / not configured) → terminal, cacheable.
 */
export interface OcrResult {
  readonly ok: boolean
  readonly text: string
  readonly provider: string
  readonly engineVersion: string
  readonly model?: string
  readonly retryable?: boolean
  readonly error?: string
}

export interface OcrProvider {
  /** stable id, e.g. "tesseract" | "ppocr" | "none" */
  readonly key: string
  /** file_parse_runs.parser_key for this provider (tesseract keeps "tesseract_ocr") */
  readonly parserKey: string
  /** file_parse_runs.parser_version — provenance + facade cache-key component */
  readonly engineVersion: string
  /** true only when the env needed to reach this engine is present */
  isConfigured(): boolean
  /** MUST always resolve (never reject); returns ok:false on any error. */
  recognize(req: OcrProviderRequest): Promise<OcrResult>
}
