// §4.D change 10 pins, driven through the REAL route registrations (requires
// --experimental-test-module-mocks — wired into the package test script):
//
//   1. `config:{otel:false}` on all four production WS routes — /ws,
//      /ws/remote-agents, /ws/asr, /api/v1/devices/control-plane — means NO
//      span named `request` is ever STARTED for their upgrades under the
//      installed (patched) @fastify/otel, while a config-less control route
//      still starts one (proves the plugin was live, not just absent);
//   2. the chat /ws per-message spans: auth WITH an envelope traceparent ⇒
//      ws.auth SERVER span remote-parented on it (token never an attribute);
//      WITHOUT one ⇒ fresh root, never any live ambient span
//      (extract-or-ROOT; see the poison note at app.listen below); malformed
//      ⇒ frame still handled, fresh root;
//   3. subscribe ⇒ CONSUMER span; typing flood + pong/unsubscribe ⇒ ZERO
//      spans; conversation_id only becomes an attribute post-auth and
//      id-capped (≤64 chars) — never from a pre-auth or oversized frame.
//
// The seams (auth, identity, roster, remote-agents daemon handler, ASR
// registry, auth-session registry) are mock.module'd so no DB/Redis is
// touched; the route/option/span plumbing under test is entirely real.
import assert from "node:assert/strict"
import { once } from "node:events"
import { test, mock } from "node:test"
import { fileURLToPath } from "node:url"
import { context, propagation, trace, SpanKind } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type Span as SdkSpan,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { FastifyOtelInstrumentation } from "@fastify/otel"
import Fastify from "fastify"
import websocket from "@fastify/websocket"
import WebSocket from "ws"

const startedSpans: ReadableSpan[] = []
const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [
    {
      onStart(span: SdkSpan) {
        startedSpans.push(span as unknown as ReadableSpan)
      },
      onEnd() {},
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    },
    new SimpleSpanProcessor(exporter),
  ],
})
context.setGlobalContextManager(new AsyncLocalStorageContextManager())
trace.setGlobalTracerProvider(provider)
propagation.setGlobalPropagator(new W3CTraceContextPropagator())

// mock.module intercepts by RESOLVED path, so specifiers point at the .ts
// sources the handlers' own `.js` imports resolve to under tsx.
const spec = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))

// (infrastructure/events is NOT mocked: importing it is side-effect-free —
// lazy redis — and setupWebSocket's onEvent registration is in-memory only.)
//
// Partial mocks: the control-plane's real import graph consumes OTHER exports
// of these modules, so each mock spreads the real namespace and overrides only
// the seam the test needs (all of them are import-side-effect-free).
async function partialMock(
  rel: string,
  overrides: Record<string, unknown>
): Promise<void> {
  const real = await import(rel)
  mock.module(spec(rel.replace(/\.js$/, ".ts")), {
    namedExports: { ...real, ...overrides },
  })
}

await partialMock("../../modules/remote-agents/service.js", {
  handleRemoteAgentDaemonConnection: async () => {},
})
await partialMock("../../modules/auth/service.js", {
  authenticateSessionToken: async () => ({
    user: { id: "u-1" },
    session: { id: "s-1" },
  }),
  authenticateSessionFromHeaders: async () => null,
})
await partialMock("../../modules/chat/participant-roster.js", {
  getConversationParticipantUseCase: async () => null,
})
await partialMock("../../modules/chat/workspace-identity.js", {
  getWorkspaceMemberIdentity: async () => ({
    workspaceId: "w-1",
    workspaceMemberId: "wm-1",
  }),
})
await partialMock("../../modules/tasks/service.js", {
  enrichTaskForUser: async (t: unknown) => t,
})
await partialMock("./auth-session-registry.js", {
  initAuthSessionRegistry: async () => {},
  registerAuthenticatedSocket: () => {},
  unregisterAuthenticatedSocket: () => {},
})
await partialMock("../../modules/asr/registry.js", {
  resolveRealtimeAsrProvider: () => ({
    key: "fake",
    isConfigured: () => true,
    createSession: () => ({
      async start() {},
      async sendAudio() {},
      async stop() {},
      close() {},
    }),
  }),
})

const { setupWebSocket } = await import("./index.js")
const { registerDeviceControlPlaneRoutes } =
  await import("../../modules/devices/control-plane.js")

const fastifyOtel = new FastifyOtelInstrumentation()
fastifyOtel.setTracerProvider(provider)

const app = Fastify()
await app.register(fastifyOtel.plugin())
await app.register(websocket)
setupWebSocket(app) // real /ws + /ws/remote-agents + real /ws/asr
registerDeviceControlPlaneRoutes(app) // real /api/v1/devices/control-plane
// control: a WS route WITHOUT otel:false must still start a request span
app.get("/ws-control", { websocket: true }, (socket: any) => {
  socket.on("message", () => socket.send("ack"))
})
// POISON at listen time. Probed reality: ws `message` events run under ROOT
// in today's fastify/ws stack — no poison (hook-, handler- or listen-scoped)
// reaches a message handler's ambient ALS context. The fresh-root test below
// therefore pins the OBSERVABLE outcome (never any live trace), and this
// poison future-proofs it against fastify/ws ever starting to propagate
// context into message events. The
// `context.active()`-swap regression itself is pinned where it is
// discriminable: envelope-trace.test.ts (ROOT_CONTEXT identity) and
// control-plane-tracing.test.ts (poisoned ambient around a direct
// runTaskFrameSpan call).
const poison = trace
  .getTracer("poison")
  .startSpan("poison-listen", { kind: SpanKind.SERVER })
const POISON_TRACE_ID = poison.spanContext().traceId
await context.with(trace.setSpan(context.active(), poison), () =>
  app.listen({ port: 0, host: "127.0.0.1" })
)
const { port } = app.server.address() as { port: number }

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
const SPAN_ID = "b7ad6b7169203331"
const TP = `00-${TRACE_ID}-${SPAN_ID}-01`

function requestSpansStarted() {
  return startedSpans.filter((s) => s.name === "request")
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

async function connect(path = "/ws"): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
  await once(ws, "open")
  return ws
}

async function flushSpans() {
  await provider.forceFlush()
  return exporter.getFinishedSpans()
}

test("upgrades on the four production WS routes start ZERO `request` spans; a config-less control route starts one", async () => {
  for (const path of [
    "/ws",
    "/ws/remote-agents",
    "/ws/asr",
    "/api/v1/devices/control-plane",
  ]) {
    const ws = await connect(path)
    ws.close()
    await once(ws, "close")
    assert.equal(
      requestSpansStarted().length,
      0,
      `request span started for ${path}`
    )
  }
  const ctl = await connect("/ws-control")
  assert.equal(
    requestSpansStarted().length,
    1,
    "the control route must prove the patched plugin is live"
  )
  ctl.close()
  await once(ctl, "close")
})

test("auth WITH traceparent ⇒ ws.auth SERVER span remote-parented; token NEVER an attribute", async () => {
  exporter.reset()
  const ws = await connect()
  ws.send(
    JSON.stringify({
      type: "auth",
      token: "super-secret-token",
      workspaceId: "w-1",
      traceparent: TP,
      tracestate: "vendor=abc",
    })
  )
  await waitForEvent(ws, "auth.ok")
  const spans = await flushSpans()
  const auth = spans.find((s) => s.name === "ws.auth")
  assert.ok(auth, `spans: ${spans.map((s) => s.name)}`)
  assert.equal(auth.kind, SpanKind.SERVER)
  assert.equal(auth.spanContext().traceId, TRACE_ID)
  assert.equal(auth.parentSpanContext?.spanId, SPAN_ID)
  assert.equal(auth.parentSpanContext?.isRemote, true)
  assert.equal(auth.attributes["synapse.ws.surface"], "chat")
  assert.equal(auth.attributes["synapse.ws.workspace_id"], "w-1")
  assert.equal(
    JSON.stringify(auth.attributes).includes("super-secret-token"),
    false
  )
  ws.close()
})

test("auth WITHOUT traceparent under the POISONED ambient ⇒ fresh root, never the poison", async () => {
  exporter.reset()
  const ws = await connect()
  ws.send(JSON.stringify({ type: "auth", token: "tok", workspaceId: "w-1" }))
  await waitForEvent(ws, "auth.ok")
  const spans = await flushSpans()
  const auth = spans.find((s) => s.name === "ws.auth")
  assert.ok(auth)
  assert.equal(auth.parentSpanContext, undefined, "must be a ROOT span")
  assert.notEqual(auth.spanContext().traceId, TRACE_ID)
  assert.notEqual(auth.spanContext().traceId, POISON_TRACE_ID)
  ws.close()
})

test("malformed traceparent ⇒ auth still succeeds (degrade-not-reject), fresh root", async () => {
  exporter.reset()
  const ws = await connect()
  ws.send(
    JSON.stringify({
      type: "auth",
      token: "tok",
      workspaceId: "w-1",
      traceparent: "00-XYZ-not-hex-01",
    })
  )
  await waitForEvent(ws, "auth.ok")
  const spans = await flushSpans()
  const auth = spans.find((s) => s.name === "ws.auth")
  assert.ok(auth, "frame must still be handled")
  assert.equal(auth.parentSpanContext, undefined)
  ws.close()
})

test("subscribe ⇒ CONSUMER span parented on the envelope; typing flood + pong/unsubscribe ⇒ zero spans", async () => {
  exporter.reset()
  const ws = await connect()
  ws.send(JSON.stringify({ type: "auth", token: "tok", workspaceId: "w-1" }))
  await waitForEvent(ws, "auth.ok")
  ws.send(
    JSON.stringify({
      type: "subscribe",
      key: "k1",
      topic: "inbox",
      traceparent: TP,
    })
  )
  // typing flood — 50 frames, MUST create zero spans (§4.D change 8)
  for (let i = 0; i < 50; i++) {
    ws.send(
      JSON.stringify({
        type: "typing",
        conversationId: "c-1",
        state: i % 2 ? "started" : "stopped",
        traceparent: TP,
      })
    )
  }
  ws.send(JSON.stringify({ type: "pong" }))
  ws.send(JSON.stringify({ type: "unsubscribe", key: "k1" }))
  await new Promise((resolve) => {
    setTimeout(resolve, 400)
  })
  const spans = await flushSpans()
  const names = spans.map((s) => s.name)
  const sub = spans.find((s) => s.name === "ws.subscribe")
  assert.ok(sub, `spans: ${names}`)
  assert.equal(sub.kind, SpanKind.CONSUMER)
  assert.equal(sub.spanContext().traceId, TRACE_ID)
  assert.equal(sub.parentSpanContext?.spanId, SPAN_ID)
  // exactly ws.auth + ws.subscribe — nothing for typing/pong/unsubscribe
  assert.equal(spans.length, 2, `unexpected spans: ${names}`)
  ws.close()
})

test("conversation_id becomes a span attribute only POST-AUTH and only when id-sized (≤64)", async () => {
  // Pre-auth subscribe: span still created, but the raw frame value must not
  // reach an exported attribute (the connection is closed by handleSubscribe).
  exporter.reset()
  const preAuth = await connect()
  preAuth.send(
    JSON.stringify({
      type: "subscribe",
      key: "k1",
      topic: "conversation",
      conversationId: "c-attacker",
    })
  )
  await once(preAuth, "close")
  let spans = await flushSpans()
  const preAuthSub = spans.find((s) => s.name === "ws.subscribe")
  assert.ok(preAuthSub)
  assert.equal(preAuthSub.attributes["synapse.ws.conversation_id"], undefined)

  // Post-auth: an oversized value is dropped, an id-sized value lands.
  exporter.reset()
  const ws = await connect()
  ws.send(JSON.stringify({ type: "auth", token: "tok", workspaceId: "w-1" }))
  await waitForEvent(ws, "auth.ok")
  ws.send(
    JSON.stringify({
      type: "subscribe",
      key: "big",
      topic: "conversation",
      conversationId: "x".repeat(100_000),
    })
  )
  ws.send(
    JSON.stringify({
      type: "subscribe",
      key: "ok",
      topic: "conversation",
      conversationId: "c-1",
    })
  )
  await new Promise((resolve) => {
    setTimeout(resolve, 300)
  })
  spans = await flushSpans()
  const subs = spans.filter((s) => s.name === "ws.subscribe")
  assert.equal(subs.length, 2, `spans: ${spans.map((s) => s.name)}`)
  const attrValues = subs.map((s) => s.attributes["synapse.ws.conversation_id"])
  assert.deepEqual(attrValues.toSorted(), ["c-1", undefined])
  ws.close()
})

test.after(async () => {
  await app.close()
  await provider.shutdown()
})
