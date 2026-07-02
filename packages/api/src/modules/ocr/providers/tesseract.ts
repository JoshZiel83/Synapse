// tesseract OCR provider — a thin HTTP client to the tesseract sidecar
// (sidecars/tesseract, native tesseract-ocr behind FastAPI). Per the
// zero-OCR-api decision the api runs NO tesseract engine in-process. All the
// wire/retry logic lives in buildSidecarOcrProvider; this file only supplies the
// tesseract-specific ids + config. engineVersion "7" and parserKey
// "tesseract_ocr" are preserved from the pre-refactor pipeline so file_parse_runs
// rows and re-parses stay consistent.

import { config } from "../../../config/index.js"
import { createLogger } from "../../../infrastructure/logger/index.js"
import { buildSidecarOcrProvider } from "./sidecar.js"

export const tesseractProvider = buildSidecarOcrProvider({
  key: "tesseract",
  parserKey: "tesseract_ocr",
  engineVersion: "7",
  model: "tesseract",
  log: createLogger("ocr.tesseract"),
  getUrl: () => config.ocr.tesseract.url,
  getTimeoutMs: () => config.ocr.tesseract.timeoutMs,
  extraBody: () => ({ langs: config.ocr.tesseract.langs }),
})
