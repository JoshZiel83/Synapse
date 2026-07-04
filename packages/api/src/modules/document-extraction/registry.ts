// Document-extraction provider registry — selects the active adapter from
// config.documentExtraction.provider. The api core never imports a concrete
// engine; it goes through here. An unknown or "none" provider resolves to the
// null provider (always ok:false), which the parse pipeline treats as "skip
// document extraction" rather than a failure. Modelled on ocr/registry.ts +
// embedding/registry.ts (config-free select() split so it is unit-testable).

import { config } from "../../config/index.js"
import { createLogger } from "../../infrastructure/logger/index.js"
import { llamaparseDocumentProvider } from "./providers/llamaparse.js"
import { localDocumentProvider } from "./providers/local.js"
import { textinDocumentProvider } from "./providers/textin.js"
import type {
  DocumentExtractionProvider,
  DocumentExtractionResult,
} from "./types.js"

const log = createLogger("documents.registry")
const warnedUnknownProviders = new Set<string>()

const nullProvider: DocumentExtractionProvider = {
  key: "none",
  parserKey: "doc_none",
  engineVersion: "0",
  capabilities: { acceptsUrl: false, maxInlineBytes: 0 },
  supports: () => false,
  isConfigured: () => false,
  extract: async (): Promise<DocumentExtractionResult> => ({
    ok: false,
    text: "",
    textFormat: "plaintext",
    provider: "none",
    engineVersion: "0",
    error: "no document-extraction provider is configured",
    retryable: false,
  }),
}

/**
 * Pure name → provider mapping (no config read), so branches are unit-testable.
 * An unrecognized provider is a LOUD skip (warn-once), never a boot crash — a typo
 * or a not-yet-wired provider must degrade to "document extraction disabled", the
 * same posture as "none".
 */
export function selectDocumentExtractionProvider(
  name: string
): DocumentExtractionProvider {
  switch (name) {
    case "local":
      return localDocumentProvider
    case "textin":
      return textinDocumentProvider
    case "llamaparse":
      return llamaparseDocumentProvider
    case "none":
      return nullProvider
    default:
      if (!warnedUnknownProviders.has(name)) {
        warnedUnknownProviders.add(name)
        log.warn(
          { provider: name },
          `unknown DOCUMENT_EXTRACTION_PROVIDER "${name}" — document extraction is disabled (skipped)`
        )
      }
      return nullProvider
  }
}

/**
 * Resolve the active document-extraction provider. When a real provider is
 * selected, config.superRefine has already guaranteed its required env (sidecar
 * URL / vendor keys) is present, so the returned provider is reachable.
 */
export function resolveDocumentExtractionProvider(): DocumentExtractionProvider {
  return selectDocumentExtractionProvider(config.documentExtraction.provider)
}
