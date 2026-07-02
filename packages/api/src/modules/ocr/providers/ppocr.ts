// PP-OCRv6 OCR provider — a thin HTTP client to the ppocr sidecar
// (sidecars/ppocr, official paddleocr on the CPU Paddle backend). The api runs
// no OCR engine in-process; this adapter only speaks the sidecar's HTTP
// contract. Shares the shape of the tesseract adapter (never-reject,
// transient/terminal classification). The tier is a deploy choice baked into
// the sidecar image; PPOCR_TIER here labels provenance (parser_version).

import { config } from "../../../config/index.js"
import { createLogger } from "../../../infrastructure/logger/index.js"
import { normalizeOcrText } from "../normalize.js"
import type { OcrProvider, OcrProviderRequest, OcrResult } from "../types.js"

const log = createLogger("ocr.ppocr")

const PARSER_KEY = "ppocr"
// Tier is read once at load (config is static). Drives parser_version provenance.
const ENGINE_VERSION = `PP-OCRv6-${config.ocr.ppocr.tier}`
const MODEL = `PP-OCRv6_${config.ocr.ppocr.tier}`

function base(partial: Partial<OcrResult>): OcrResult {
  return {
    ok: false,
    text: "",
    provider: "ppocr",
    engineVersion: ENGINE_VERSION,
    ...partial,
  }
}

async function recognize(req: OcrProviderRequest): Promise<OcrResult> {
  const url = config.ocr.ppocr.url
  if (!url) {
    return base({
      error: "ppocr sidecar URL is not configured",
      retryable: false,
    })
  }

  let endpoint: string
  try {
    endpoint = new URL("ocr", url.endsWith("/") ? url : `${url}/`).toString()
  } catch {
    return base({ error: `invalid PPOCR_URL: ${url}`, retryable: false })
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        image_base64: Buffer.from(req.bytes).toString("base64"),
        mime_type: req.mimeType,
      }),
      signal: AbortSignal.timeout(config.ocr.ppocr.timeoutMs),
    })

    // 503 = the sidecar is saturated OR still warming its model → retry later.
    if (response.status === 503) {
      return base({
        error: "ppocr sidecar is busy or loading",
        retryable: true,
      })
    }
    if (!response.ok) {
      return base({
        error: `ppocr sidecar returned HTTP ${response.status}`,
        retryable: response.status >= 500,
      })
    }

    const data = (await response.json()) as { text?: unknown }
    const text = normalizeOcrText(
      typeof data?.text === "string" ? data.text : ""
    )
    if (!text) {
      return base({ error: "ppocr returned no text", retryable: false })
    }
    return {
      ok: true,
      text,
      provider: "ppocr",
      engineVersion: ENGINE_VERSION,
      model: MODEL,
      raw: data,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn({ err }, "ppocr sidecar request failed")
    return base({ error: `ppocr request failed: ${message}`, retryable: true })
  }
}

export const ppocrProvider: OcrProvider = {
  key: "ppocr",
  parserKey: PARSER_KEY,
  engineVersion: ENGINE_VERSION,
  capabilities: { supportsPdf: false, languages: "auto" },
  isConfigured: () => Boolean(config.ocr.ppocr.url),
  recognize,
}
