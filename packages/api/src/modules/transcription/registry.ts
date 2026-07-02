// Transcription provider registry — selects the active adapter from
// config.transcription.provider. The api core never imports a concrete engine; it
// goes through here. An unknown or "none" provider resolves to the null provider
// (always ok:false), which the AI audio-fallback surfaces as "reference
// transcript unavailable" rather than crashing the outbound-LLM path.

import { config } from "../../config/index.js"
import { createLogger } from "../../infrastructure/logger/index.js"
import { sherpaProvider } from "./providers/sherpa.js"
import type { TranscriptionProvider, TranscriptionResult } from "./types.js"

const log = createLogger("transcription.registry")
const warnedUnknownProviders = new Set<string>()

const nullProvider: TranscriptionProvider = {
  key: "none",
  engineVersion: "0",
  isConfigured: () => false,
  transcribe: async (): Promise<TranscriptionResult> => ({
    ok: false,
    text: "",
    provider: "none",
    engineVersion: "0",
    error: "no transcription provider is configured",
    retryable: false,
  }),
}

/**
 * Resolve the active transcription provider. Returns the null provider when the
 * selected provider is unknown/"none" (isConfigured() is false → audio fallback
 * degrades to "unavailable"). config.transcription.provider is already
 * alias-normalized (the deprecated "sherpa-onnx" value maps to "sherpa"), and
 * config.superRefine has guaranteed a selected sherpa has its sidecar URL.
 */
export function resolveTranscriptionProvider(): TranscriptionProvider {
  const provider = config.transcription.provider
  switch (provider) {
    case "sherpa":
      return sherpaProvider
    case "none":
      return nullProvider
    default:
      // A selected-but-unrecognized provider (typo, or one not yet wired) must
      // be a LOUD skip, not a silent no-op.
      if (!warnedUnknownProviders.has(provider)) {
        warnedUnknownProviders.add(provider)
        log.warn(
          { provider },
          `unknown TRANSCRIPTION_PROVIDER "${provider}" — audio transcription is disabled (skipped)`
        )
      }
      return nullProvider
  }
}
