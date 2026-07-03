// Generic realtime-ASR session start() preflight failures + their canonical
// mapping — shared by every provider (Volcengine, sherpa-stream, future cloud).
//
// A session's start() must, on ANY operational failure, emit exactly one terminal
// asr.error AND reject (see RealtimeAsrSession in types.ts). These helpers map the
// two provider-neutral preflight failures (invalid audio config, concurrency cap,
// missing config) to canonical ASR_* codes + the retryable flag. Vendor-specific
// upstream errors are mapped by each provider's own errors module.

import type { RealtimeAsrSocketEventPayloadMap } from "@synapse/shared"
import { z } from "zod"

type AsrErrorCode = RealtimeAsrSocketEventPayloadMap["asr.error"]["code"]

/** A provider is selected but the env needed to reach it is absent. Deterministic
 *  (not retryable). The message is provider-specific (passed by the caller). */
export class AsrNotConfiguredError extends Error {
  readonly name = "AsrNotConfiguredError"
}

/** The active provider's concurrency cap is reached. Transient (retryable once a
 *  slot frees). */
export class AsrConcurrencyLimitError extends Error {
  readonly name = "AsrConcurrencyLimitError"

  constructor() {
    super("ASR concurrency limit reached")
  }
}

/** The client audio config is schema-valid but this provider cannot accept it
 *  (e.g. a sidecar that only reads raw PCM, not ogg/opus). Deterministic. */
export class AsrUnsupportedAudioError extends Error {
  readonly name = "AsrUnsupportedAudioError"
}

export function startErrorCode(error: unknown): AsrErrorCode {
  if (
    error instanceof z.ZodError ||
    error instanceof AsrUnsupportedAudioError
  ) {
    return "ASR_INVALID_AUDIO_CONFIG"
  }
  if (error instanceof AsrConcurrencyLimitError) {
    return "ASR_CONCURRENCY_LIMIT_REACHED"
  }
  return "ASR_UPSTREAM_CONNECT_FAILED"
}

export function startErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => issue.message).join("; ")
  }
  if (error instanceof Error) {
    return error.message
  }
  return "Failed to connect to the ASR provider"
}

/** true = transient (retry may help), false = deterministic. Invalid audio config
 *  (ZodError) and a not-configured server are terminal; a concurrency-limit or an
 *  upstream-connect failure is transient. */
export function startRetryable(error: unknown): boolean {
  return (
    !(error instanceof z.ZodError) &&
    !(error instanceof AsrUnsupportedAudioError) &&
    !(error instanceof AsrNotConfiguredError)
  )
}
