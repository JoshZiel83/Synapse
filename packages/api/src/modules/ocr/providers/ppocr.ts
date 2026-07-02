// PP-OCRv6 OCR provider — a thin HTTP client to the ppocr sidecar
// (sidecars/ppocr, official paddleocr on the CPU Paddle backend). The api runs
// no OCR engine in-process. All the wire/retry logic lives in
// buildSidecarOcrProvider; this file only supplies the ppocr-specific ids +
// config. The tier is a deploy choice baked into the sidecar image; PPOCR_TIER
// here labels provenance (parser_version).

import { config } from "../../../config/index.js"
import { createLogger } from "../../../infrastructure/logger/index.js"
import { buildSidecarOcrProvider } from "./sidecar.js"

// Read once at load (config is static).
const TIER = config.ocr.ppocr.tier

export const ppocrProvider = buildSidecarOcrProvider({
  key: "ppocr",
  parserKey: "ppocr",
  engineVersion: `PP-OCRv6-${TIER}`,
  model: `PP-OCRv6_${TIER}`,
  log: createLogger("ocr.ppocr"),
  getUrl: () => config.ocr.ppocr.url,
  getTimeoutMs: () => config.ocr.ppocr.timeoutMs,
})
