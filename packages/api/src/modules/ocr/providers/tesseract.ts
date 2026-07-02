// tesseract OCR provider — a thin HTTP client to the tesseract sidecar
// (sidecars/tesseract, native tesseract-ocr behind FastAPI). Per the
// zero-OCR-api decision, the api runs NO tesseract engine in-process; this
// adapter only speaks the sidecar's HTTP contract. engineVersion + parserKey
// are preserved from the pre-refactor pipeline so file_parse_runs rows and
// re-parses stay consistent.

import { config } from "../../../config/index.js"
import { createLogger } from "../../../infrastructure/logger/index.js"
import { normalizeOcrText } from "../normalize.js"
import type { OcrProvider, OcrProviderRequest, OcrResult } from "../types.js"

const log = createLogger("ocr.tesseract")

// Preserved verbatim from the old TESSERACT_OCR_PARSER_VERSION so provenance +
// re-parse semantics don't churn.
const ENGINE_VERSION = "7"
const PARSER_KEY = "tesseract_ocr"

function base(partial: Partial<OcrResult>): OcrResult {
  return {
    ok: false,
    text: "",
    provider: "tesseract",
    engineVersion: ENGINE_VERSION,
    ...partial,
  }
}

async function recognize(req: OcrProviderRequest): Promise<OcrResult> {
  const url = config.ocr.tesseract.url
  if (!url) {
    return base({
      error: "tesseract OCR sidecar URL is not configured",
      retryable: false,
    })
  }

  let endpoint: string
  try {
    endpoint = new URL("ocr", url.endsWith("/") ? url : `${url}/`).toString()
  } catch {
    return base({ error: `invalid TESSERACT_URL: ${url}`, retryable: false })
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        image_base64: Buffer.from(req.bytes).toString("base64"),
        mime_type: req.mimeType,
        langs: config.ocr.tesseract.langs,
      }),
      signal: AbortSignal.timeout(config.ocr.tesseract.timeoutMs),
    })

    // 503 = the sidecar's bounded worker pool is saturated → retry later.
    if (response.status === 503) {
      return base({ error: "tesseract OCR sidecar is busy", retryable: true })
    }
    if (!response.ok) {
      // 5xx = server-side transient; 4xx = our request is wrong (terminal).
      return base({
        error: `tesseract OCR sidecar returned HTTP ${response.status}`,
        retryable: response.status >= 500,
      })
    }

    const data = (await response.json()) as { text?: unknown }
    const text = normalizeOcrText(
      typeof data?.text === "string" ? data.text : ""
    )
    if (!text) {
      // Engine ran but found no text → deterministic, terminal (no retry).
      return base({ error: "tesseract OCR returned no text", retryable: false })
    }
    return {
      ok: true,
      text,
      provider: "tesseract",
      engineVersion: ENGINE_VERSION,
      model: "tesseract",
      raw: data,
    }
  } catch (err) {
    // Network error / timeout / abort → transient, retryable.
    const message = err instanceof Error ? err.message : String(err)
    log.warn({ err }, "tesseract OCR sidecar request failed")
    return base({
      error: `tesseract OCR request failed: ${message}`,
      retryable: true,
    })
  }
}

export const tesseractProvider: OcrProvider = {
  key: "tesseract",
  parserKey: PARSER_KEY,
  engineVersion: ENGINE_VERSION,
  capabilities: { supportsPdf: false, languages: "auto" },
  isConfigured: () => Boolean(config.ocr.tesseract.url),
  recognize,
}
