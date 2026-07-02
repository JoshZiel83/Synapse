// OCR provider registry — selects the active adapter from config.ocr.provider.
// The api core never imports a concrete engine; it goes through here. An unknown
// or "none" provider resolves to the null provider (always ok:false), which the
// parse pipeline treats as "skip OCR" rather than a failure.

import { config } from "../../config/index.js"
import { createLogger } from "../../infrastructure/logger/index.js"
import { ppocrProvider } from "./providers/ppocr.js"
import { tesseractProvider } from "./providers/tesseract.js"
import type { OcrProvider, OcrResult } from "./types.js"

const log = createLogger("ocr.registry")
const warnedUnknownProviders = new Set<string>()

const nullProvider: OcrProvider = {
  key: "none",
  parserKey: "ocr_none",
  engineVersion: "0",
  isConfigured: () => false,
  recognize: async (): Promise<OcrResult> => ({
    ok: false,
    text: "",
    provider: "none",
    engineVersion: "0",
    error: "no OCR provider is configured",
    retryable: false,
  }),
}

/**
 * Resolve the active OCR provider. Returns the null provider when the selected
 * provider is unknown/"none" (so isConfigured() is false → parse skips OCR).
 * When a real provider is selected, config.superRefine has already guaranteed
 * its required URL is present, so the returned provider is reachable.
 */
export function resolveOcrProvider(): OcrProvider {
  const provider = config.ocr.provider
  switch (provider) {
    case "tesseract":
      return tesseractProvider
    case "ppocr":
      return ppocrProvider
    case "none":
      return nullProvider
    default:
      // A selected-but-unrecognized provider (typo, or a provider not yet wired)
      // must be a LOUD skip, not a silent no-op. warn-once (resolveOcrProvider is
      // called per parse-strategy resolution + per recognize).
      if (!warnedUnknownProviders.has(provider)) {
        warnedUnknownProviders.add(provider)
        log.warn(
          { provider },
          `unknown OCR_PROVIDER "${provider}" — image OCR is disabled (skipped)`
        )
      }
      return nullProvider
  }
}
