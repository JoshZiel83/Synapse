// Whisper transcription provider — a thin HTTP client to the whisper sidecar
// (sidecars/whisper, faster-whisper / CTranslate2 + ffmpeg transcode behind
// FastAPI). A second, genuinely different engine behind the same abstraction
// (CTranslate2 vs sherpa-onnx), and MIT-licensed end-to-end (OpenAI Whisper
// weights + the Systran CT2 conversions) — the permissive-license alternative to
// the sherpa/SenseVoice default. All wire/retry logic lives in
// buildSidecarTranscriptionProvider; this file only supplies the whisper-specific
// ids + config.
//
// The model SIZE is baked into the sidecar image (a build choice); the
// TRANSCRIPTION_WHISPER_MODEL label here must match it — it drives the
// engineVersion cache key + provenance (mirrors the ppocr tier label).

import { config } from "../../../config/index.js"
import { createLogger } from "../../../infrastructure/logger/index.js"
import { buildSidecarTranscriptionProvider } from "./sidecar.js"

// Read once at load (config is static).
const MODEL = config.transcription.whisper.model

export const whisperProvider = buildSidecarTranscriptionProvider({
  key: "whisper",
  engineVersion: `whisper:${MODEL}`,
  model: `whisper-${MODEL}`,
  log: createLogger("transcription.whisper"),
  getUrl: () => config.transcription.whisper.url,
  getTimeoutMs: () => config.transcription.whisper.timeoutMs,
})
