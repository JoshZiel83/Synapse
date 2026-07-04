// modules/document-extraction/ — the document-extraction abstraction layer.
//
// The api core bundles NO concrete document-parsing engine. It selects a provider
// by env (config.documentExtraction.provider) and calls the ONE facade
// `extractDocument` (index.ts). Every provider — the local Apache Tika sidecar,
// cloud/API vendors (TextIn today) — is an out-of-process adapter behind this
// interface. The 5th sibling of modules/ocr / modules/embedding /
// modules/transcription / modules/asr; modelled on modules/ocr.
//
// KEY DEVIATION from the OCR layer (deliberate — documents are not images):
// EMPTY EXTRACTION IS A SUCCESS. A scanned / text-layerless PDF returns
// `ok:true, text:""` and STILL carries `structuredJson` (page count) — the parse
// pipeline records it as a succeeded run with metadata, exactly as the pre-refactor
// pdf-parse path did. `ok:false` is reserved for genuine faults (encrypted /
// corrupt / unreachable). (OCR, by contrast, treats empty text as a terminal
// failure — that rule must NOT be copied here or every scanned PDF would regress
// from succeeded to failed.)

/** Public input to the facade. `bytes` is optional: the facade loads them from
 *  the content-addressed store by `sha256` when the caller doesn't already have
 *  them. `sha256` is the cache key. */
export interface ExtractDocumentInput {
  readonly sha256: string
  readonly mimeType: string
  readonly bytes?: Uint8Array
  /** Original filename, when known — passed to the engine as an extension hint. */
  readonly filename?: string
  /** Blob size (from content_blobs) — lets the facade's size-gate refuse an
   *  over-limit inline transport BEFORE materializing the blob into heap. */
  readonly sizeBytes?: number
}

/** A cloud object reference (Phase-3 `object-ref` transport — e.g. AWS Textract's
 *  S3Object, Google Doc AI's gs:// URI). Distinct from a fetch-url: the vendor
 *  reads it with its OWN credentials in-account, not an https GET. */
export interface DocumentObjectRef {
  readonly scheme: "s3" | "gcs"
  readonly bucket: string
  readonly key: string
  readonly region?: string
}

/** How the document bytes reach the provider. The facade selects this from the
 *  file size + the provider's capabilities (§ transport union). `bytes` = inline
 *  (base64/multipart); `fetch-url` = a presigned https URL the vendor GETs;
 *  `object-ref` = a bucket reference the vendor reads with its own credentials.
 *  Only `bytes` is exercised today (no presign-capable content backend yet); the
 *  URL/object-ref arms are the built-but-dormant seam a future vendor plugs into. */
export type DocumentTransport =
  | { readonly mode: "bytes"; readonly bytes: Uint8Array }
  | {
      readonly mode: "fetch-url"
      readonly url: string
      readonly expiresAt?: number
    }
  | { readonly mode: "object-ref"; readonly ref: DocumentObjectRef }

/** What an adapter receives. Common fields are flat; the payload rides in
 *  `transport` so a URL/object-ref provider is NOT handed a materialized buffer
 *  (the heap-blowup the size-gate prevents). Bytes-only adapters call
 *  `requireBytes(req)`. */
export interface DocumentProviderRequest {
  readonly sha256: string
  readonly mimeType: string
  readonly filename?: string
  readonly transport: DocumentTransport
}

/** Bytes-only adapters (Tika sidecar, TextIn, LlamaParse upload) call this: returns
 *  the inline bytes, or null when the facade handed a URL/object-ref transport this
 *  adapter can't serve (→ the adapter returns a terminal "unsupported transport"). */
export function requireBytes(req: DocumentProviderRequest): Uint8Array | null {
  return req.transport.mode === "bytes" ? req.transport.bytes : null
}

/** Declares how a provider wants its bytes — drives the facade's transport +
 *  size-gate. `maxInlineBytes` caps inline transport (above it, a bytes-only
 *  provider fails fast rather than materializing an absurd blob into heap). */
export interface DocumentProviderCapabilities {
  readonly acceptsUrl: boolean
  readonly maxInlineBytes: number
}

/** Async (submit-and-release) provider results. `submit()` returns an opaque vendor
 *  job token (persisted to file_parse_runs.metadata) + never rejects; a later
 *  `poll()` returns `pending` (re-poll) or a terminal `DocumentExtractionResult`. */
export interface DocumentSubmitResult {
  readonly ok: boolean
  readonly jobToken?: string
  readonly provider: string
  readonly engineVersion: string
  readonly retryable?: boolean
  readonly error?: string
}

export type DocumentPollResult =
  | { readonly status: "pending" }
  | ({ readonly status: "done" } & DocumentExtractionResult)

/**
 * The normalized result every adapter maps INTO. `text` is the only field
 * guaranteed on success — and on success it MAY be empty (a scanned PDF is a
 * success carrying only page metadata). `textFormat` discriminates plaintext
 * (local Tika today) from markdown (markdown-native cloud vendors later) so a
 * future consumer never has to guess the flavour. `structuredJson` carries the
 * minimal `{schemaVersion, pageCount, contentType}` today and is genuinely open
 * for richer structure later (it round-trips opaquely into file_parse_outputs).
 *
 * `retryable` classifies a FAILURE: true = transient (sidecar down / timeout /
 * 5xx / saturated) → the parse pipeline may retry and the facade must NOT cache
 * it; false = deterministic (encrypted / corrupt / unsupported / not configured)
 * → terminal, cacheable.
 */
export interface DocumentExtractionResult {
  readonly ok: boolean
  readonly text: string
  readonly textFormat: "plaintext" | "markdown"
  readonly structuredJson?: Record<string, unknown>
  readonly provider: string
  readonly engineVersion: string
  readonly model?: string
  readonly retryable?: boolean
  readonly error?: string
}

export interface DocumentExtractionProvider {
  /** stable id, e.g. "local" | "textin" | "llamaparse" | "none" */
  readonly key: string
  /** file_parse_runs.parser_key for this provider (names the real engine family) */
  readonly parserKey: string
  /** how this provider wants its bytes (transport + inline size cap) */
  readonly capabilities: DocumentProviderCapabilities
  /** true = async submit-and-release (implements submit()/poll()); false/undefined
   *  = synchronous (implements extract()). */
  readonly isAsync?: boolean
  /**
   * file_parse_runs.parser_version — provenance + facade cache-key component.
   * A static label kept in single-knob lockstep with the engine baked into the
   * sidecar image (compose sets it from the same TIKA_VERSION build-arg, exactly
   * like whisper's TRANSCRIPTION_WHISPER_MODEL ← WHISPER_MODEL_SIZE). Bumping the
   * baked engine without the label would poison the cache + mislabel provenance,
   * so the two MUST move together.
   */
  readonly engineVersion: string
  /** Which MIME types this provider claims to extract (routing + clean decline). */
  supports(mimeType: string): boolean
  /** true only when the env needed to reach this provider is present */
  isConfigured(): boolean
  /** SYNC providers: MUST always resolve (never reject); ok:false on any error.
   *  Async providers may leave this as a never-configured stub. */
  extract(req: DocumentProviderRequest): Promise<DocumentExtractionResult>
  /** ASYNC providers only: submit a job, return an opaque token. Never rejects. */
  submit?(req: DocumentProviderRequest): Promise<DocumentSubmitResult>
  /** ASYNC providers only: poll a submitted job by token. Never rejects. */
  poll?(jobToken: string): Promise<DocumentPollResult>
}
