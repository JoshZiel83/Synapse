// Volcengine 豆包 SAUC → canonical ASR_* error mapping for UPSTREAM (provider
// native) errors. The generic start() preflight mapping lives in ../../preflight.ts
// (shared across providers); this module holds only the Volcengine-specific
// numeric error-code translation. Moved verbatim from the pre-abstraction
// modules/asr/service.ts.

import type { RealtimeAsrSocketEventPayloadMap } from "@synapse/shared"

type AsrErrorPayload = RealtimeAsrSocketEventPayloadMap["asr.error"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function providerErrorMessage(payload: unknown) {
  if (typeof payload === "string" && payload.trim()) {
    return payload.trim()
  }

  if (Buffer.isBuffer(payload)) {
    const text = payload.toString("utf8").trim()
    return text || "ASR provider error"
  }

  if (!isRecord(payload)) {
    return "ASR provider error"
  }

  if (typeof payload.message === "string" && payload.message.trim()) {
    return payload.message.trim()
  }
  if (typeof payload.error === "string" && payload.error.trim()) {
    return payload.error.trim()
  }

  return "ASR provider error"
}

export function mapProviderError(
  code: number,
  payload: unknown,
  providerLogId?: string
): AsrErrorPayload {
  const message = providerErrorMessage(payload)

  if (code === 45000001) {
    return {
      code: "ASR_PROVIDER_INVALID_REQUEST",
      message,
      retryable: false,
      providerCode: code,
      providerLogId,
    }
  }

  if (code === 45000002) {
    return {
      code: "ASR_PROVIDER_EMPTY_AUDIO",
      message,
      retryable: false,
      providerCode: code,
      providerLogId,
    }
  }

  if (code === 45000081) {
    return {
      code: "ASR_PROVIDER_AUDIO_TIMEOUT",
      message,
      retryable: true,
      providerCode: code,
      providerLogId,
    }
  }

  if (code === 45000151) {
    return {
      code: "ASR_PROVIDER_AUDIO_FORMAT_INVALID",
      message,
      retryable: false,
      providerCode: code,
      providerLogId,
    }
  }

  if (code === 55000031) {
    return {
      code: "ASR_PROVIDER_BUSY",
      message,
      retryable: true,
      providerCode: code,
      providerLogId,
    }
  }

  return {
    code:
      code >= 55000000 ? "ASR_PROVIDER_INTERNAL_ERROR" : "ASR_PROVIDER_ERROR",
    message,
    retryable: code >= 55000000,
    providerCode: code,
    providerLogId,
  }
}
