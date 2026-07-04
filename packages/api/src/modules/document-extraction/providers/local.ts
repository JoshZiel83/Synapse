// Local document-extraction provider — a thin HTTP client to the docextract
// sidecar (sidecars/docextract, Apache Tika Server behind a FastAPI shim). The api
// runs NO document engine in-process. All wire/retry logic lives in
// buildSidecarDocumentProvider; this file only supplies the local-specific ids +
// config + format coverage. engineVersion is a static provenance label kept in
// single-knob lockstep with the TIKA_VERSION baked into the sidecar image (compose
// sets config.documentExtraction.local.engineVersion from the same value).

import { config } from "../../../config/index.js"
import { createLogger } from "../../../infrastructure/logger/index.js"
import { isDocumentMimeType } from "../mime.js"
import { buildSidecarDocumentProvider } from "./sidecar.js"

const OUTPUT_FORMAT = config.documentExtraction.local.outputFormat

// Fold the output flavor into the provenance label so switching text↔markdown
// invalidates the parse cache + is visible in file_parse_runs.parser_version.
const ENGINE_VERSION =
  OUTPUT_FORMAT === "markdown"
    ? `${config.documentExtraction.local.engineVersion}-md`
    : config.documentExtraction.local.engineVersion

export const localDocumentProvider = buildSidecarDocumentProvider({
  key: "local",
  // parserKey names the real engine family (Apache Tika), NOT the old "pdf_parse"
  // — provenance must reflect what actually ran.
  parserKey: "tika",
  engineVersion: ENGINE_VERSION,
  model: "tika",
  log: createLogger("documents.local"),
  getUrl: () => config.documentExtraction.local.url,
  getTimeoutMs: () => config.documentExtraction.local.timeoutMs,
  // Matches the sidecar's DOCEXTRACT_MAX_BYTES (40 MB decoded); above it the facade
  // fails fast instead of base64-ing an over-limit blob the sidecar would 413.
  maxInlineBytes: 40 * 1024 * 1024,
  // Tika parses the full document set this layer is responsible for.
  supports: (mimeType) => isDocumentMimeType(mimeType),
  // Phase-2 rich tier: request markdown when configured (Tika XHTML → markdown).
  extraBody: () => ({ output_format: OUTPUT_FORMAT }),
})
