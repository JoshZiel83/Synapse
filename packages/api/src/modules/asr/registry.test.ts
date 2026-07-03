import test from "node:test"
import assert from "node:assert/strict"
import type {
  RealtimeAsrSocketEvent,
  RealtimeAsrSocketEventPayloadMap,
} from "@synapse/shared"
import { selectRealtimeAsrProvider } from "./registry.js"
import type { AsrLogger } from "./types.js"

const noopLogger: AsrLogger = {
  info() {},
  warn() {},
  error() {},
}

test("selectRealtimeAsrProvider resolves volcengine and none by name", () => {
  assert.equal(selectRealtimeAsrProvider("volcengine").key, "volcengine")
  assert.equal(selectRealtimeAsrProvider("none").key, "none")
})

test("selectRealtimeAsrProvider falls back to the null provider for an unknown name", () => {
  const provider = selectRealtimeAsrProvider("bogus-vendor")
  assert.equal(provider.key, "none")
  assert.equal(provider.isConfigured(), false)
  // warn-once must not throw on the second unknown resolution.
  assert.equal(selectRealtimeAsrProvider("bogus-vendor").key, "none")
})

test("null provider start() emits a terminal asr.error AND rejects (failure contract)", async () => {
  const events: RealtimeAsrSocketEvent[] = []
  const session = selectRealtimeAsrProvider("none").createSession({
    userId: "u1",
    logger: noopLogger,
    sendEvent: (event) => {
      events.push(event)
      return true
    },
  })

  await assert.rejects(() =>
    session.start({
      format: "pcm",
      codec: "raw",
      rate: 16000,
      bits: 16,
      channel: 1,
    })
  )

  assert.equal(events.length, 1)
  const emitted = events[0]!
  assert.equal(emitted.type, "asr.error")
  const payload =
    emitted.payload as RealtimeAsrSocketEventPayloadMap["asr.error"]
  assert.equal(payload.code, "ASR_UPSTREAM_CONNECT_FAILED")
  assert.equal(payload.retryable, false)

  // The remaining methods are inert and never throw.
  await session.sendAudio(Buffer.alloc(0))
  await session.stop()
  session.close()
})
