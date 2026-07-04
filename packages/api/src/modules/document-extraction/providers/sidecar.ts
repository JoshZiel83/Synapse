// Shared HTTP-client document-extraction provider factory. A sidecar-backed
// adapter (the local Apache Tika sidecar today) is the endpoint join + fetch +
// failure classification + never-reject contract, ONCE, so the retry-mapping
// can't drift. Modelled on ocr/providers/sidecar.ts — with the ONE deliberate
// difference that defines this layer:
//
//   EMPTY TEXT IS A SUCCESS. A 200 with text:"" (a scanned / text-layerless PDF)
//   returns ok:true and still carries structuredJson (page count). The OCR
//   factory treats empty text as a terminal FAILURE; copying that here would
//   regress every scanned PDF from succeeded to failed. Do not.

import { parseJsonObject } from "@synapse/shared"
import { normalizeDocumentText } from "../normalize.js"
import { requireBytes } from "../types.js"
import type {
  DocumentExtractionProvider,
  DocumentProviderRequest,
  DocumentExtractionResult,
} from "../types.js"

type Logger = ReturnType<
  typeof import("../../../infrastructure/logger/index.js").createLogger
>

export interface SidecarDocumentOptions {
  readonly key: string
  readonly parserKey: string
  readonly engineVersion: string
  readonly model: string
  readonly log: Logger
  /** Read at call time so an unconfigured provider reports isConfigured()=false. */
  getUrl(): string
  getTimeoutMs(): number
  /** Which MIME types this sidecar's engine claims to handle. */
  supports(mimeType: string): boolean
  /** Inline byte cap — above it the facade fails fast (matches the sidecar body limit). */
  maxInlineBytes: number
  /** Extra request-body fields (e.g. { output_format } for the local provider). */
  extraBody?(): Record<string, unknown>
}

export function buildSidecarDocumentProvider(
  opts: SidecarDocumentOptions
): DocumentExtractionProvider {
  function fail(
    partial: Partial<DocumentExtractionResult>
  ): DocumentExtractionResult {
    return {
      ok: false,
      text: "",
      textFormat: "plaintext",
      provider: opts.key,
      engineVersion: opts.engineVersion,
      ...partial,
    }
  }

  async function extract(
    req: DocumentProviderRequest
  ): Promise<DocumentExtractionResult> {
    const bytes = requireBytes(req)
    if (!bytes) {
      return fail({
        error: `${opts.key} document sidecar requires inline bytes transport`,
        retryable: false,
      })
    }
    const url = opts.getUrl()
    if (!url) {
      return fail({
        error: `${opts.key} document sidecar URL is not configured`,
        retryable: false,
      })
    }

    let endpoint: string
    try {
      endpoint = new URL(
        "extract",
        url.endsWith("/") ? url : `${url}/`
      ).toString()
    } catch {
      return fail({
        error: `invalid ${opts.key} document sidecar URL: ${url}`,
        retryable: false,
      })
    }

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content_base64: Buffer.from(bytes).toString("base64"),
          mime_type: req.mimeType,
          filename: req.filename,
          ...opts.extraBody?.(),
        }),
        signal: AbortSignal.timeout(opts.getTimeoutMs()),
      })

      // 503 = the sidecar's bounded pool is saturated OR the engine (Tika JVM) is
      // still warming → retry later.
      if (response.status === 503) {
        return fail({
          error: `${opts.key} document sidecar is busy or loading`,
          retryable: true,
        })
      }
      if (!response.ok) {
        // 5xx = server-side transient; 4xx (incl. 422 = encrypted/corrupt/
        // unsupported, the deterministic engine failures) = terminal.
        return fail({
          error: `${opts.key} document sidecar returned HTTP ${response.status}`,
          retryable: response.status >= 500,
        })
      }

      // Read as text + parse via the shared object-only decoder (never throws;
      // {} on malformed) rather than the unchecked response.json() the boundary
      // guard forbids.
      const data = parseJsonObject(await response.text())
      const text = normalizeDocumentText(
        typeof data.text === "string" ? data.text : ""
      )
      const textFormat =
        data.text_format === "markdown" ? "markdown" : "plaintext"
      const structuredJson =
        data.structured && typeof data.structured === "object"
          ? (data.structured as Record<string, unknown>)
          : undefined

      // SUCCESS — including empty text (scanned/text-layerless doc): ok:true,
      // carrying whatever structure the engine reported (page count).
      return {
        ok: true,
        text,
        textFormat,
        structuredJson,
        provider: opts.key,
        engineVersion: opts.engineVersion,
        model: opts.model,
      }
    } catch (err) {
      // Network error / timeout / abort → transient, retryable.
      const message = err instanceof Error ? err.message : String(err)
      opts.log.warn({ err }, `${opts.key} document sidecar request failed`)
      return fail({
        error: `${opts.key} document request failed: ${message}`,
        retryable: true,
      })
    }
  }

  return {
    key: opts.key,
    parserKey: opts.parserKey,
    engineVersion: opts.engineVersion,
    capabilities: { acceptsUrl: false, maxInlineBytes: opts.maxInlineBytes },
    supports: opts.supports,
    isConfigured: () => Boolean(opts.getUrl()),
    extract,
  }
}
