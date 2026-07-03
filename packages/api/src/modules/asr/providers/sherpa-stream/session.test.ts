import { test, after } from "node:test"
import assert from "node:assert/strict"
import { WebSocketServer } from "ws"
import type {
  RealtimeAsrSocketEvent,
  RealtimeAsrSocketEventPayloadMap,
} from "@synapse/shared"
import type { AsrLogger } from "../../types.js"

// Start a fake sidecar on a random free port, THEN point config at it (config is
// validated once at import) before importing the session. This proves the adapter
// against a real WebSocket peer speaking our sidecar protocol.
const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 })
await new Promise<void>((resolve) => wss.once("listening", () => resolve()))
const address = wss.address()
const port = typeof address === "object" && address ? address.port : 0
process.env.REALTIME_ASR_SHERPA_URL = `ws://127.0.0.1:${port}`

wss.on("connection", (ws) => {
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      ws.send(
        JSON.stringify({
          type: "partial",
          displayText: "hello",
          unstableText: "hello",
        })
      )
      return
    }
    const message = JSON.parse(data.toString()) as { type: string }
    if (message.type === "stop") {
      ws.send(
        JSON.stringify({
          type: "final",
          text: "hello world",
          startTimeMs: 0,
          endTimeMs: 1000,
        })
      )
      ws.send(
        JSON.stringify({
          type: "completed",
          text: "hello world",
          durationMs: 1000,
        })
      )
    }
  })
})

const { SherpaStreamRealtimeAsrSession } = await import("./session.js")

after(() => {
  wss.close()
})

const noopLogger: AsrLogger = {
  info() {},
  warn() {},
  error() {},
}

const PCM_CONFIG = {
  format: "pcm",
  codec: "raw",
  rate: 16000,
  bits: 16,
  channel: 1,
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error("timed out")), ms)
    }),
  ])
}

test("sherpa-stream maps sidecar partial/final/completed to canonical events", async () => {
  const events: RealtimeAsrSocketEvent[] = []
  let resolveCompleted: () => void = () => {}
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve
  })

  const session = new SherpaStreamRealtimeAsrSession({
    userId: "u1",
    logger: noopLogger,
    sendEvent: (event) => {
      events.push(event)
      if (event.type === "asr.completed") resolveCompleted()
      return true
    },
  })

  await session.start(PCM_CONFIG)
  await session.sendAudio(Buffer.from([0, 0, 0, 0]))
  await session.stop()
  await withTimeout(completed, 3000)

  const types = events.map((event) => event.type)
  assert.ok(types.includes("asr.started"), "expected asr.started")
  assert.ok(types.includes("asr.partial"), "expected asr.partial")
  assert.ok(types.includes("asr.segment.final"), "expected asr.segment.final")
  assert.ok(types.includes("asr.completed"), "expected asr.completed")
})

test("sherpa-stream rejects non-PCM audio with ASR_INVALID_AUDIO_CONFIG (emit + reject)", async () => {
  const events: RealtimeAsrSocketEvent[] = []
  const session = new SherpaStreamRealtimeAsrSession({
    userId: "u1",
    logger: noopLogger,
    sendEvent: (event) => {
      events.push(event)
      return true
    },
  })

  await assert.rejects(() =>
    session.start({
      format: "ogg",
      codec: "opus",
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
  assert.equal(payload.code, "ASR_INVALID_AUDIO_CONFIG")
  assert.equal(payload.retryable, false)
})
