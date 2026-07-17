import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { RealtimeAsrClientMessageSchema } from "./asr.js"
import { ChatSocketClientMessageSchema } from "./chat.js"
import { wireTraceContextFields } from "./trace-context.js"
import { MAX_TRACESTATE_LENGTH } from "../utils/traceparent.js"

const VALID_TRACEPARENT =
  "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
const VALID_TRACESTATE = "vendor=abc,congo=t61rcWkgMzE"

const Fragment = z.object(wireTraceContextFields)

test("wireTraceContextFields: valid pair passes through verbatim", () => {
  const parsed = Fragment.parse({
    traceparent: VALID_TRACEPARENT,
    tracestate: VALID_TRACESTATE,
  })
  assert.equal(parsed.traceparent, VALID_TRACEPARENT)
  assert.equal(parsed.tracestate, VALID_TRACESTATE)
})

test("wireTraceContextFields: absent fields parse as absent", () => {
  const parsed = Fragment.parse({})
  assert.equal(parsed.traceparent, undefined)
  assert.equal(parsed.tracestate, undefined)
})

test("wireTraceContextFields: malformed traceparent degrades to absent, never rejects (§4.F)", () => {
  for (const bad of [
    "not-a-traceparent",
    // version 01 — the strict regex is version-00 only
    "01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    // all-zero trace-id / span-id are invalid per W3C §3.2
    "00-00000000000000000000000000000000-b7ad6b7169203331-01",
    "00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01",
    // uppercase hex is invalid
    "00-0AF7651916CD43DD8448EB211C80319C-B7AD6B7169203331-01",
    12345,
    { nested: true },
    null,
  ]) {
    const parsed = Fragment.parse({ traceparent: bad })
    assert.equal(parsed.traceparent, undefined, String(bad))
  }
})

test("wireTraceContextFields: oversized tracestate degrades to absent", () => {
  const parsed = Fragment.parse({
    traceparent: VALID_TRACEPARENT,
    tracestate: `v=${"x".repeat(MAX_TRACESTATE_LENGTH)}`,
  })
  assert.equal(parsed.traceparent, VALID_TRACEPARENT)
  assert.equal(parsed.tracestate, undefined)
})

test("chat frames: auth/subscribe/typing carry the fragment; a malformed value never rejects the frame", () => {
  const auth = ChatSocketClientMessageSchema.parse({
    type: "auth",
    workspaceId: "ws-1",
    traceparent: VALID_TRACEPARENT,
    tracestate: VALID_TRACESTATE,
  })
  assert.equal(auth.type, "auth")
  assert.equal(
    (auth as { traceparent?: string }).traceparent,
    VALID_TRACEPARENT
  )

  const subscribe = ChatSocketClientMessageSchema.parse({
    type: "subscribe",
    key: "inbox-1",
    topic: "inbox",
    traceparent: "garbage",
  })
  assert.equal(subscribe.type, "subscribe")
  assert.equal((subscribe as { traceparent?: string }).traceparent, undefined)

  const typing = ChatSocketClientMessageSchema.parse({
    type: "typing",
    conversationId: "c-1",
    state: "started",
    traceparent: VALID_TRACEPARENT,
  })
  assert.equal(typing.type, "typing")
  assert.equal(
    (typing as { traceparent?: string }).traceparent,
    VALID_TRACEPARENT
  )
})

test("asr frames: only `start` carries the fragment; malformed degrades, frame parses", () => {
  const start = RealtimeAsrClientMessageSchema.parse({
    type: "start",
    audio: { format: "pcm", codec: "raw", rate: 16000, bits: 16, channel: 1 },
    traceparent: VALID_TRACEPARENT,
    tracestate: VALID_TRACESTATE,
  })
  assert.equal(start.type, "start")
  assert.equal(
    (start as { traceparent?: string }).traceparent,
    VALID_TRACEPARENT
  )

  const degraded = RealtimeAsrClientMessageSchema.parse({
    type: "start",
    audio: { format: "pcm", codec: "raw", rate: 16000, bits: 16, channel: 1 },
    traceparent: "00-zz-zz-zz",
    tracestate: 42,
  })
  assert.equal(degraded.type, "start")
  assert.equal((degraded as { traceparent?: string }).traceparent, undefined)
  assert.equal((degraded as { tracestate?: string }).tracestate, undefined)

  // stop/cancel/pong envelopes deliberately have NO trace fields — an unknown
  // key is stripped by the plain-object schema, not admitted.
  const stop = RealtimeAsrClientMessageSchema.parse({
    type: "stop",
    traceparent: VALID_TRACEPARENT,
  })
  assert.equal("traceparent" in stop, false)
})
