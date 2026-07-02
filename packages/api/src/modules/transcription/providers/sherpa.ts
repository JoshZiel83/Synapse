// sherpa-onnx transcription provider — a thin HTTP client to the sherpa-asr
// sidecar (sidecars/sherpa-asr, a sherpa-onnx offline recognizer + ffmpeg
// transcode behind FastAPI). Per the zero-ASR-api decision the api runs NO
// speech engine in-process; this adapter only speaks the sidecar's HTTP
// contract. There is a single sidecar adapter today, so the wire/retry logic is
// inline here (no shared factory yet) — extract one when a second adapter lands.
//
// engineVersion embeds the baked model so a model swap invalidates the facade
// cache; bump SHERPA_ASR_MODEL below (and the sidecar image) together.

import { parseJsonObject } from "@synapse/shared"
import { config } from "../../../config/index.js"
import { createLogger } from "../../../infrastructure/logger/index.js"
import { normalizeTranscript } from "../normalize.js"
import type {
  TranscriptionProvider,
  TranscriptionRequest,
  TranscriptionResult,
} from "../types.js"

const log = createLogger("transcription.sherpa")

// The model baked into the default sherpa-asr sidecar image. Labels provenance +
// is the engineVersion cache-key component. Swapping the baked model (a different
// Dockerfile model set) should bump this so stale transcripts aren't served.
const SHERPA_ASR_MODEL = "sensevoice-small"
const ENGINE_VERSION = `sherpa-onnx:${SHERPA_ASR_MODEL}`

function base(partial: Partial<TranscriptionResult>): TranscriptionResult {
  return {
    ok: false,
    text: "",
    provider: "sherpa",
    engineVersion: ENGINE_VERSION,
    ...partial,
  }
}

async function transcribe(
  req: TranscriptionRequest
): Promise<TranscriptionResult> {
  const url = config.transcription.sherpa.url
  if (!url) {
    return base({
      error: "sherpa transcription sidecar URL is not configured",
      retryable: false,
    })
  }

  let endpoint: string
  try {
    endpoint = new URL(
      "transcribe",
      url.endsWith("/") ? url : `${url}/`
    ).toString()
  } catch {
    return base({
      error: `invalid sherpa transcription sidecar URL: ${url}`,
      retryable: false,
    })
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        audio_base64: Buffer.from(req.bytes).toString("base64"),
        mime_type: req.mimeType,
      }),
      signal: AbortSignal.timeout(config.transcription.sherpa.timeoutMs),
    })

    // 503 = the sidecar's bounded pool is saturated OR the model is still
    // loading → retry later.
    if (response.status === 503) {
      return base({
        error: "sherpa transcription sidecar is busy or loading",
        retryable: true,
      })
    }
    if (!response.ok) {
      // 5xx = server-side transient; 4xx = our request is wrong (terminal).
      return base({
        error: `sherpa transcription sidecar returned HTTP ${response.status}`,
        retryable: response.status >= 500,
      })
    }

    // Read as text + parse via the shared object-only decoder (never throws;
    // {} on malformed) rather than the unchecked response.json() the boundary
    // guard forbids.
    const data = parseJsonObject(await response.text())
    const text = normalizeTranscript(
      typeof data.text === "string" ? data.text : ""
    )
    if (!text) {
      // Engine ran but produced no speech text → deterministic, terminal.
      return base({
        error: "sherpa transcription returned no text",
        retryable: false,
      })
    }
    return {
      ok: true,
      text,
      provider: "sherpa",
      engineVersion: ENGINE_VERSION,
      model: SHERPA_ASR_MODEL,
    }
  } catch (err) {
    // Network error / timeout / abort → transient, retryable.
    const message = err instanceof Error ? err.message : String(err)
    log.warn({ err }, "sherpa transcription sidecar request failed")
    return base({
      error: `sherpa transcription request failed: ${message}`,
      retryable: true,
    })
  }
}

export const sherpaProvider: TranscriptionProvider = {
  key: "sherpa",
  engineVersion: ENGINE_VERSION,
  isConfigured: () => Boolean(config.transcription.sherpa.url),
  transcribe,
}
