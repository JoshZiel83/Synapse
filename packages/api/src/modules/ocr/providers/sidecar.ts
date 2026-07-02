// Shared HTTP-client OCR provider factory. Both sidecar-backed adapters
// (tesseract, ppocr) are identical except for their id, config source, and any
// extra request fields — so the endpoint join + fetch + failure classification
// + never-reject contract live here ONCE, and each adapter is a small options
// object. Keeps the retry-mapping in a single place so it can't drift.

import { parseJsonObject } from "@synapse/shared"
import { normalizeOcrText } from "../normalize.js"
import type { OcrProvider, OcrProviderRequest, OcrResult } from "../types.js"

type Logger = ReturnType<
  typeof import("../../../infrastructure/logger/index.js").createLogger
>

export interface SidecarOcrOptions {
  readonly key: string
  readonly parserKey: string
  readonly engineVersion: string
  readonly model: string
  readonly log: Logger
  /** Read at call time so an unconfigured provider reports isConfigured()=false. */
  getUrl(): string
  getTimeoutMs(): number
  /** Extra request-body fields (e.g. { langs } for tesseract). */
  extraBody?(): Record<string, unknown>
}

export function buildSidecarOcrProvider(opts: SidecarOcrOptions): OcrProvider {
  function base(partial: Partial<OcrResult>): OcrResult {
    return {
      ok: false,
      text: "",
      provider: opts.key,
      engineVersion: opts.engineVersion,
      ...partial,
    }
  }

  async function recognize(req: OcrProviderRequest): Promise<OcrResult> {
    const url = opts.getUrl()
    if (!url) {
      return base({
        error: `${opts.key} OCR sidecar URL is not configured`,
        retryable: false,
      })
    }

    let endpoint: string
    try {
      endpoint = new URL("ocr", url.endsWith("/") ? url : `${url}/`).toString()
    } catch {
      return base({
        error: `invalid ${opts.key} OCR sidecar URL: ${url}`,
        retryable: false,
      })
    }

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          image_base64: Buffer.from(req.bytes).toString("base64"),
          mime_type: req.mimeType,
          ...opts.extraBody?.(),
        }),
        signal: AbortSignal.timeout(opts.getTimeoutMs()),
      })

      // 503 = the sidecar's bounded pool is saturated OR (ppocr) still warming
      // its model → retry later.
      if (response.status === 503) {
        return base({
          error: `${opts.key} OCR sidecar is busy or loading`,
          retryable: true,
        })
      }
      if (!response.ok) {
        // 5xx = server-side transient; 4xx = our request is wrong (terminal).
        return base({
          error: `${opts.key} OCR sidecar returned HTTP ${response.status}`,
          retryable: response.status >= 500,
        })
      }

      // Read as text + parse via the shared object-only decoder (never throws;
      // {} on malformed) rather than the unchecked response.json() the boundary
      // guard forbids.
      const data = parseJsonObject(await response.text())
      const text = normalizeOcrText(
        typeof data.text === "string" ? data.text : ""
      )
      if (!text) {
        // Engine ran but found no text → deterministic, terminal (no retry).
        return base({
          error: `${opts.key} OCR returned no text`,
          retryable: false,
        })
      }
      return {
        ok: true,
        text,
        provider: opts.key,
        engineVersion: opts.engineVersion,
        model: opts.model,
      }
    } catch (err) {
      // Network error / timeout / abort → transient, retryable.
      const message = err instanceof Error ? err.message : String(err)
      opts.log.warn({ err }, `${opts.key} OCR sidecar request failed`)
      return base({
        error: `${opts.key} OCR request failed: ${message}`,
        retryable: true,
      })
    }
  }

  return {
    key: opts.key,
    parserKey: opts.parserKey,
    engineVersion: opts.engineVersion,
    isConfigured: () => Boolean(opts.getUrl()),
    recognize,
  }
}
