// sherpa-onnx transcription provider — a thin HTTP client to the sherpa-asr
// sidecar (sidecars/sherpa-asr, a sherpa-onnx offline recognizer + ffmpeg
// transcode behind FastAPI). Per the zero-ASR-api decision the api runs NO speech
// engine in-process. All the wire/retry logic lives in
// buildSidecarTranscriptionProvider; this file only supplies the sherpa-specific
// ids + config. engineVersion embeds the baked model so a model swap invalidates
// the facade cache; bump SHERPA_ASR_MODEL below (and the sidecar image) together.

import { config } from "../../../config/index.js"
import { createLogger } from "../../../infrastructure/logger/index.js"
import { buildSidecarTranscriptionProvider } from "./sidecar.js"

// The model baked into the default sherpa-asr sidecar image.
const SHERPA_ASR_MODEL = "sensevoice-small"

export const sherpaProvider = buildSidecarTranscriptionProvider({
  key: "sherpa",
  engineVersion: `sherpa-onnx:${SHERPA_ASR_MODEL}`,
  model: SHERPA_ASR_MODEL,
  log: createLogger("transcription.sherpa"),
  getUrl: () => config.transcription.sherpa.url,
  getTimeoutMs: () => config.transcription.sherpa.timeoutMs,
})
