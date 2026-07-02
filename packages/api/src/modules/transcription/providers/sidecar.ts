// Shared HTTP-client transcription provider factory. Both sidecar-backed adapters
// (sherpa-onnx SenseVoice, faster-whisper) speak the SAME wire contract — POST
// { audio_base64, mime_type } to /transcribe, get { text } back — and share the
// same failure classification + never-reject guarantee, so that logic lives here
// ONCE and each adapter is a small options object (mirrors modules/ocr/sidecar.ts).

import { parseJsonObject } from "@synapse/shared"
import { normalizeTranscript } from "../normalize.js"
import type {
  TranscriptionProvider,
  TranscriptionRequest,
  TranscriptionResult,
} from "../types.js"

type Logger = ReturnType<
  typeof import("../../../infrastructure/logger/index.js").createLogger
>

export interface SidecarTranscriptionOptions {
  readonly key: string
  /** cache-key component + log/provenance field; encodes engine + model. */
  readonly engineVersion: string
  readonly model: string
  readonly log: Logger
  /** Read at call time so an unconfigured provider reports isConfigured()=false. */
  getUrl(): string
  getTimeoutMs(): number
}

export function buildSidecarTranscriptionProvider(
  opts: SidecarTranscriptionOptions
): TranscriptionProvider {
  function base(partial: Partial<TranscriptionResult>): TranscriptionResult {
    return {
      ok: false,
      text: "",
      provider: opts.key,
      engineVersion: opts.engineVersion,
      ...partial,
    }
  }

  async function transcribe(
    req: TranscriptionRequest
  ): Promise<TranscriptionResult> {
    const url = opts.getUrl()
    if (!url) {
      return base({
        error: `${opts.key} transcription sidecar URL is not configured`,
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
        error: `invalid ${opts.key} transcription sidecar URL: ${url}`,
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
        signal: AbortSignal.timeout(opts.getTimeoutMs()),
      })

      // 503 = the sidecar's bounded pool is saturated OR the model is still
      // loading → retry later.
      if (response.status === 503) {
        return base({
          error: `${opts.key} transcription sidecar is busy or loading`,
          retryable: true,
        })
      }
      if (!response.ok) {
        // 5xx = server-side transient; 4xx = our request is wrong (terminal).
        return base({
          error: `${opts.key} transcription sidecar returned HTTP ${response.status}`,
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
          error: `${opts.key} transcription returned no text`,
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
      opts.log.warn({ err }, `${opts.key} transcription sidecar request failed`)
      return base({
        error: `${opts.key} transcription request failed: ${message}`,
        retryable: true,
      })
    }
  }

  return {
    key: opts.key,
    engineVersion: opts.engineVersion,
    isConfigured: () => Boolean(opts.getUrl()),
    transcribe,
  }
}
