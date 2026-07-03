// Realtime-ASR provider registry — selects the active adapter from
// config.asr.provider. The /ws/asr gateway never imports a concrete vendor; it
// goes through resolveRealtimeAsrProvider(). An unknown or "none" provider
// resolves to the null provider, whose session emits a terminal asr.error AND
// rejects start() — reproducing (and slightly improving on) today's unconfigured
// soft-fail so the gateway tears the socket down cleanly. Mirrors
// transcription/registry.ts / ocr/registry.ts.

import { config } from "../../config/index.js"
import { createLogger } from "../../infrastructure/logger/index.js"
import { sherpaStreamProvider } from "./providers/sherpa-stream/index.js"
import { volcengineProvider } from "./providers/volcengine/index.js"
import type { RealtimeAsrProvider, RealtimeAsrSession } from "./types.js"

const log = createLogger("asr.registry")
const warnedUnknownProviders = new Set<string>()

const nullProvider: RealtimeAsrProvider = {
  key: "none",
  isConfigured: () => false,
  createSession: ({ sendEvent }): RealtimeAsrSession => ({
    // Honor the RealtimeAsrSession start() contract: emit a terminal asr.error
    // AND throw, so the gateway runs its catch → closeAsrClient(1011) and tears
    // the socket down (as an unconfigured server does today).
    async start() {
      sendEvent({
        type: "asr.error",
        payload: {
          code: "ASR_UPSTREAM_CONNECT_FAILED",
          message: "no realtime ASR provider is configured",
          retryable: false,
        },
      })
      throw new Error("no realtime ASR provider is configured")
    },
    async sendAudio() {},
    async stop() {},
    close() {},
  }),
}

/**
 * Pure selection by resolved provider name — the config-free core of the
 * registry, so the switch (incl. the warn-once unknown branch and the null
 * provider) is unit-testable without stubbing the config singleton.
 */
export function selectRealtimeAsrProvider(
  providerName: string
): RealtimeAsrProvider {
  switch (providerName) {
    case "volcengine":
      return volcengineProvider
    case "sherpa-stream":
      return sherpaStreamProvider
    case "none":
      return nullProvider
    default:
      // A selected-but-unrecognized provider (typo, or one not yet wired) must
      // be a LOUD skip, not a silent no-op.
      if (!warnedUnknownProviders.has(providerName)) {
        warnedUnknownProviders.add(providerName)
        log.warn(
          { provider: providerName },
          `unknown ASR_PROVIDER "${providerName}" — realtime dictation is disabled (skipped)`
        )
      }
      return nullProvider
  }
}

/** Resolve the active realtime-ASR provider from config.asr.provider (already an
 *  alias-normalized non-empty string). */
export function resolveRealtimeAsrProvider(): RealtimeAsrProvider {
  return selectRealtimeAsrProvider(config.asr.provider)
}
