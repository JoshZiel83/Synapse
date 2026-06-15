import test from "node:test"
import assert from "node:assert/strict"
import { mapProviderError, validateRealtimeAsrAudioConfig } from "./service.js"

test("validateRealtimeAsrAudioConfig accepts PCM/raw and OGG/opus only", () => {
  assert.deepEqual(
    validateRealtimeAsrAudioConfig({
      format: "pcm",
      codec: "raw",
      rate: 16000,
      bits: 16,
      channel: 1,
    }),
    {
      format: "pcm",
      codec: "raw",
      rate: 16000,
      bits: 16,
      channel: 1,
    }
  )

  assert.deepEqual(
    validateRealtimeAsrAudioConfig({
      format: "ogg",
      codec: "opus",
      rate: 16000,
      bits: 16,
      channel: 1,
    }),
    {
      format: "ogg",
      codec: "opus",
      rate: 16000,
      bits: 16,
      channel: 1,
    }
  )

  assert.throws(
    () =>
      validateRealtimeAsrAudioConfig({
        format: "pcm",
        codec: "opus",
        rate: 16000,
        bits: 16,
        channel: 1,
      }),
    /PCM audio must use the raw codec/
  )

  assert.throws(
    () =>
      validateRealtimeAsrAudioConfig({
        format: "ogg",
        codec: "raw",
        rate: 16000,
        bits: 16,
        channel: 1,
      }),
    /OGG audio must use the opus codec/
  )

  assert.throws(() =>
    validateRealtimeAsrAudioConfig({
      format: "webm",
      codec: "opus",
      rate: 16000,
      bits: 16,
      channel: 1,
    })
  )
})

test("mapProviderError marks provider busy as retryable", () => {
  assert.deepEqual(mapProviderError(55000031, { message: "busy" }, "log-1"), {
    code: "ASR_PROVIDER_BUSY",
    message: "busy",
    retryable: true,
    providerCode: 55000031,
    providerLogId: "log-1",
  })
})
