// The ASR session-span state machine (§4.D change 9) driven through the REAL
// /ws/asr handler over a live WebSocket, with the DB/registry seams
// mock.module'd (requires --experimental-test-module-mocks — wired into the
// package test script). Pins:
//   1. exactly ONE `asr.session {key}` SERVER span per provider session,
//      remote-parented on the start frame's envelope traceparent;
//   2. an audio-frame flood creates ZERO additional spans — counters only,
//      landing as attributes at end time;
//   3. asr.segment.final span events are capped at 64 and never carry text;
//   4. start WITHOUT / with a MALFORMED traceparent ⇒ frame still handled,
//      fresh root (extract-or-ROOT);
//   5. outcome precedence: completed/error (truthful terminal) beats the
//      'aborted' teardown fallback; socket kill mid-session ⇒ 'aborted';
//   6. two sequential sessions on one connection ⇒ two independent spans, no
//      counter/event bleed;
//   7. a LATE event from a finished session (contract-breaching provider)
//      never ends or annotates a successor session's span;
//   8. double-start protocol violation ⇒ the open span ends 'aborted' once.
import assert from "node:assert/strict"
import { once } from "node:events"
import { test, mock } from "node:test"
import { fileURLToPath } from "node:url"
import { context, propagation, trace } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import Fastify from "fastify"
import websocket from "@fastify/websocket"
import WebSocket from "ws"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})
context.setGlobalContextManager(new AsyncLocalStorageContextManager())
trace.setGlobalTracerProvider(provider)
propagation.setGlobalPropagator(new W3CTraceContextPropagator())

// mock.module intercepts by RESOLVED path, so specifiers point at the .ts
// sources the handler's own `.js` imports resolve to under tsx.
const spec = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))

// ── controllable fake provider ───────────────────────────────────────────────
type Sender = (event: any) => boolean
const senders: Sender[] = []
let startBehavior: "ok" | "reject-after-emit" = "ok"
const fakeProvider = {
  key: "fake",
  isConfigured: () => true,
  createSession({ sendEvent }: { sendEvent: Sender }) {
    senders.push(sendEvent)
    return {
      async start() {
        if (startBehavior === "reject-after-emit") {
          sendEvent({
            type: "asr.error",
            payload: {
              code: "ASR_UPSTREAM_CONNECT_FAILED",
              message: "x",
              retryable: false,
            },
          })
          throw new Error("upstream connect failed")
        }
        sendEvent({
          type: "asr.started",
          payload: { at: new Date().toISOString() },
        })
      },
      async sendAudio() {},
      async stop() {
        sendEvent({
          type: "asr.completed",
          payload: { transcript: "t", durationMs: 1 },
        })
      },
      close() {},
    }
  },
}

// ── module mocks (registered BEFORE importing asr.ts) ───────────────────────
mock.module(spec("../../modules/auth/service.ts"), {
  namedExports: {
    authenticateSessionToken: async () => ({
      user: { id: "u-1" },
      session: { id: "s-1" },
    }),
    authenticateSessionFromHeaders: async () => null,
  },
})
mock.module(spec("../../modules/chat/workspace-identity.ts"), {
  namedExports: {
    getWorkspaceMemberIdentity: async () => ({
      workspaceId: "w-1",
      workspaceMemberId: "wm-1",
    }),
  },
})
mock.module(spec("../../modules/asr/registry.ts"), {
  namedExports: { resolveRealtimeAsrProvider: () => fakeProvider },
})
mock.module(spec("./auth-session-registry.ts"), {
  namedExports: {
    initAuthSessionRegistry: async () => {},
    registerAuthenticatedSocket: () => {},
    unregisterAuthenticatedSocket: () => {},
  },
})

const { setupAsrWebSocket } = await import("./asr.js")

const app = Fastify()
await app.register(websocket)
setupAsrWebSocket(app)
await app.listen({ port: 0, host: "127.0.0.1" })
const { port } = app.server.address() as { port: number }

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
const SPAN_ID = "b7ad6b7169203331"
const TP = `00-${TRACE_ID}-${SPAN_ID}-01`

const START_AUDIO = {
  format: "pcm",
  codec: "raw",
  rate: 16000,
  bits: 16,
  channel: 1,
}

function waitForEvent(ws: WebSocket, type: string, ms = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${type}`)),
      ms
    )
    const onMsg = (raw: any) => {
      const evt = JSON.parse(String(raw))
      if (evt.type === type) {
        clearTimeout(timer)
        ws.off("message", onMsg)
        resolve(evt)
      }
    }
    ws.on("message", onMsg)
  })
}

async function connectAndAuth(): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/asr`)
  await once(ws, "open")
  ws.send(JSON.stringify({ type: "auth", token: "tok", workspaceId: "w-1" }))
  await waitForEvent(ws, "auth.ok")
  return ws
}

async function flushSpans() {
  await provider.forceFlush()
  return exporter.getFinishedSpans()
}

const settle = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

test("flood: ONE session span, remote-parented; 200 audio frames ⇒ zero extra spans; segment events capped at 64, no text", async () => {
  exporter.reset()
  const ws = await connectAndAuth()
  ws.send(
    JSON.stringify({
      type: "start",
      audio: START_AUDIO,
      traceparent: TP,
      tracestate: "vendor=abc",
    })
  )
  await waitForEvent(ws, "asr.started")

  const chunk = Buffer.alloc(320, 7)
  for (let i = 0; i < 200; i++) ws.send(chunk)
  await settle(300) // let audio frames drain
  // 100 final segments — over the 64 cap — emitted by the provider
  for (let i = 0; i < 100; i++) {
    senders.at(-1)!({
      type: "asr.segment.final",
      payload: { segmentIndex: i, text: `seg-${i}` },
    })
  }
  ws.send(JSON.stringify({ type: "stop" }))
  await waitForEvent(ws, "asr.completed")
  await settle(100)

  const spans = await flushSpans()
  assert.equal(
    spans.length,
    1,
    `expected exactly ONE span, got ${spans.map((s) => s.name)}`
  )
  const span = spans[0]!
  assert.equal(span.name, "asr.session fake")
  assert.equal(span.spanContext().traceId, TRACE_ID)
  assert.equal(span.parentSpanContext?.spanId, SPAN_ID)
  assert.equal(span.parentSpanContext?.isRemote, true)
  assert.equal(span.attributes["synapse.asr.outcome"], "completed")
  assert.equal(span.attributes["synapse.asr.audio_frames"], 200)
  assert.equal(span.attributes["synapse.asr.audio_bytes"], 200 * 320)
  const segEvents = span.events.filter((e) => e.name === "asr.segment.final")
  assert.equal(segEvents.length, 64, "segment span events capped at 64")
  // transcript text must NOT ride on span events
  for (const e of segEvents) {
    assert.equal(
      Object.keys(e.attributes ?? {}).some((k) => k.includes("text")),
      false
    )
  }
  ws.close()
  await settle(100)
  // close AFTER completed ⇒ still exactly one span (no 'aborted' twin)
  assert.equal((await flushSpans()).length, 1)
})

test("start WITHOUT traceparent ⇒ fresh root; malformed ⇒ degraded fresh root, frame still handled; kill ⇒ aborted", async () => {
  exporter.reset()
  const ws = await connectAndAuth()
  ws.send(JSON.stringify({ type: "start", audio: START_AUDIO }))
  await waitForEvent(ws, "asr.started")
  ws.send(JSON.stringify({ type: "cancel" }))
  await once(ws, "close")
  await settle(100)
  let spans = await flushSpans()
  assert.equal(spans.length, 1)
  assert.equal(spans[0]!.parentSpanContext, undefined)
  assert.notEqual(spans[0]!.spanContext().traceId, TRACE_ID)
  assert.equal(spans[0]!.attributes["synapse.asr.outcome"], "cancelled")

  exporter.reset()
  const ws2 = await connectAndAuth()
  ws2.send(
    JSON.stringify({
      type: "start",
      audio: START_AUDIO,
      traceparent: "00-zz-zz-zz",
    })
  )
  await waitForEvent(ws2, "asr.started") // malformed trace field NEVER rejects the frame
  ws2.terminate() // hard kill mid-session
  await settle(200)
  spans = await flushSpans()
  assert.equal(spans.length, 1)
  assert.equal(spans[0]!.parentSpanContext, undefined)
  assert.equal(spans[0]!.attributes["synapse.asr.outcome"], "aborted")
})

test("provider start rejection (contract emit+reject) ⇒ 'error' outcome wins over 'aborted'", async () => {
  exporter.reset()
  startBehavior = "reject-after-emit"
  const ws = await connectAndAuth()
  ws.send(
    JSON.stringify({ type: "start", audio: START_AUDIO, traceparent: TP })
  )
  await waitForEvent(ws, "asr.error")
  await once(ws, "close")
  await settle(150)
  const spans = await flushSpans()
  assert.equal(spans.length, 1)
  assert.equal(spans[0]!.attributes["synapse.asr.outcome"], "error")
  assert.equal(
    spans[0]!.attributes["synapse.asr.error_code"],
    "ASR_UPSTREAM_CONNECT_FAILED"
  )
  startBehavior = "ok"
})

test("two sequential sessions on one connection ⇒ two spans, no counter/event bleed", async () => {
  exporter.reset()
  const ws = await connectAndAuth()

  // session 1: 10 frames, 3 segments
  ws.send(JSON.stringify({ type: "start", audio: START_AUDIO }))
  await waitForEvent(ws, "asr.started")
  for (let i = 0; i < 10; i++) ws.send(Buffer.alloc(100, 1))
  await settle(150)
  for (let i = 0; i < 3; i++) {
    senders.at(-1)!({
      type: "asr.segment.final",
      payload: { segmentIndex: i, text: "x" },
    })
  }
  ws.send(JSON.stringify({ type: "stop" }))
  await waitForEvent(ws, "asr.completed")

  // session 2: 5 frames, 1 segment
  ws.send(JSON.stringify({ type: "start", audio: START_AUDIO }))
  await waitForEvent(ws, "asr.started")
  for (let i = 0; i < 5; i++) ws.send(Buffer.alloc(100, 1))
  await settle(150)
  senders.at(-1)!({
    type: "asr.segment.final",
    payload: { segmentIndex: 0, text: "y" },
  })
  ws.send(JSON.stringify({ type: "stop" }))
  await waitForEvent(ws, "asr.completed")
  ws.close()
  await settle(100)

  await provider.forceFlush()
  const spans = exporter
    .getFinishedSpans()
    .filter((s) => s.name === "asr.session fake")
  assert.equal(spans.length, 2, `got ${spans.length} session spans`)
  const [s1, s2] = spans
  assert.equal(s1!.attributes["synapse.asr.audio_frames"], 10)
  assert.equal(
    s1!.events.filter((e) => e.name === "asr.segment.final").length,
    3
  )
  assert.equal(s2!.attributes["synapse.asr.audio_frames"], 5)
  assert.equal(
    s2!.events.filter((e) => e.name === "asr.segment.final").length,
    1
  )
  assert.equal(s1!.attributes["synapse.asr.outcome"], "completed")
  assert.equal(s2!.attributes["synapse.asr.outcome"], "completed")
})

test("a LATE event from a finished session never ends or annotates the successor session's span", async () => {
  exporter.reset()
  const ws = await connectAndAuth()

  // session 1 runs to completion…
  ws.send(JSON.stringify({ type: "start", audio: START_AUDIO }))
  await waitForEvent(ws, "asr.started")
  const staleSender = senders.at(-1)!
  ws.send(JSON.stringify({ type: "stop" }))
  await waitForEvent(ws, "asr.completed")

  // …session 2 opens on the same connection…
  ws.send(
    JSON.stringify({ type: "start", audio: START_AUDIO, traceparent: TP })
  )
  await waitForEvent(ws, "asr.started")

  // …then session 1's (finished) provider breaches its contract with LATE
  // events. They must not touch session 2's span or tear its session down.
  staleSender({
    type: "asr.segment.final",
    payload: { segmentIndex: 99, text: "stale" },
  })
  staleSender({
    type: "asr.error",
    payload: { code: "STALE_SESSION", message: "late", retryable: false },
  })
  await settle(100)
  assert.equal(
    (await flushSpans()).length,
    1,
    "only session 1's span may be ended by its own late events"
  )

  // session 2 still ends with ITS truthful outcome and clean events
  ws.send(JSON.stringify({ type: "stop" }))
  await waitForEvent(ws, "asr.completed")
  ws.close()
  await settle(100)
  const spans = await flushSpans()
  assert.equal(spans.length, 2)
  const s2 = spans[1]!
  assert.equal(s2.spanContext().traceId, TRACE_ID)
  assert.equal(s2.attributes["synapse.asr.outcome"], "completed")
  assert.equal(s2.attributes["synapse.asr.error_code"], undefined)
  assert.equal(
    s2.events.filter((e) => e.name === "asr.segment.final").length,
    0,
    "the stale segment event must not land on session 2's span"
  )
})

test("double-start protocol violation ⇒ the open session span ends 'aborted' exactly once", async () => {
  exporter.reset()
  const ws = await connectAndAuth()
  ws.send(JSON.stringify({ type: "start", audio: START_AUDIO }))
  await waitForEvent(ws, "asr.started")
  ws.send(JSON.stringify({ type: "start", audio: START_AUDIO }))
  await once(ws, "close")
  await settle(150)
  await provider.forceFlush()
  const spans = exporter
    .getFinishedSpans()
    .filter((s) => s.name === "asr.session fake")
  assert.equal(spans.length, 1)
  assert.equal(spans[0]!.attributes["synapse.asr.outcome"], "aborted")
})

test.after(async () => {
  await app.close()
  await provider.shutdown()
})
