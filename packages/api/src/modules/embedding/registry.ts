// Embedding provider registry — selects the active adapter from
// config.embedding.provider. The api core never imports a concrete engine; it goes
// through here. An unknown or "none" provider resolves to the null provider (always
// ok:false, retryable:false), which the query path degrades to lexical-only recall
// and the index path records as an intentional "semantic disabled" (lexical_ready).
// Mirrors modules/transcription/registry.ts + modules/asr/registry.ts (the
// select/resolve split so the switch is unit-testable without the config singleton).

import { config } from "../../config/index.js"
import { createLogger } from "../../infrastructure/logger/index.js"
import { localEmbeddingProvider } from "./providers/local.js"
import { openAiCompatibleProvider } from "./providers/openai-compatible.js"
import type { EmbeddingProvider } from "./types.js"

const log = createLogger("embedding.registry")
const warnedUnknownProviders = new Set<string>()

const nullProvider: EmbeddingProvider = {
  key: "none",
  engineVersion: "0",
  dimension: 0,
  isConfigured: () => false,
  embed: async () => ({
    ok: false,
    vectors: [],
    provider: "none",
    engineVersion: "0",
    error: "no embedding provider is configured",
    retryable: false,
  }),
}

/**
 * Pure selection by resolved provider name — the config-free core so the switch
 * (incl. the warn-once unknown branch + the null provider) is unit-testable without
 * stubbing the config singleton.
 */
export function selectEmbeddingProvider(name: string): EmbeddingProvider {
  switch (name) {
    case "local":
      return localEmbeddingProvider
    case "openai-compatible":
      return openAiCompatibleProvider
    case "none":
      return nullProvider
    default:
      // A selected-but-unrecognized provider (typo, or one not yet wired) must be a
      // LOUD skip, not a silent no-op.
      if (!warnedUnknownProviders.has(name)) {
        warnedUnknownProviders.add(name)
        log.warn(
          { provider: name },
          `unknown EMBEDDING_PROVIDER "${name}" — semantic embedding is disabled (skipped)`
        )
      }
      return nullProvider
  }
}

/** Resolve the active embedding provider from config.embedding.provider. */
export function resolveEmbeddingProvider(): EmbeddingProvider {
  return selectEmbeddingProvider(config.embedding.provider)
}
