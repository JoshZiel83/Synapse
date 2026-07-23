// P-B2 (service-worker carrier replay) — round-2 addition beyond the §7 manifest.
//
// The service workers are the REAL sender for the online chat POST and the
// read-watermark POST. This probe reproduces their `fetchJson` header assembly
// (`{ ...replayTraceHeaders(entry.traceparent, entry.createdAt|updatedAt) }`)
// against a local echo server and drives the SHARED `flushOutboxQueue` loop, so
// the outbox path is exercised end-to-end. Asserts the replay matrix: a fresh
// valid carrier is sent once, a >24h or malformed carrier is dropped, the
// read-watermark path behaves identically off `updatedAt`, and the api-side W3C
// extract of the replayed header yields the original trace + span.
//
// Run: npx tsx scripts/trace-probes/p-b2-sw-outbox-replay.ts
import http from "node:http"
import net from "node:net"
import { once } from "node:events"
import {
  context,
  defaultTextMapGetter,
  trace,
  ROOT_CONTEXT,
} from "@opentelemetry/api"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import {
  flushOutboxQueue,
  replayTraceHeaders,
  type PendingOutboxMessage,
} from "@synapse/shared/chat-queue"
import { check, finish } from "./_shared.js"

const VALID = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
const nowIso = () => new Date().toISOString()
const agoIso = (ms: number) => new Date(Date.now() - ms).toISOString()

// Echo server: records the traceparent header of every POST.
const seen: Array<string | undefined> = []
const server = http.createServer((req, res) => {
  seen.push(req.headers["traceparent"] as string | undefined)
  res.writeHead(200, { "content-type": "application/json" })
  res.end("{}")
})
server.listen(0, "127.0.0.1")
await once(server, "listening")
const { port } = server.address() as net.AddressInfo
const url = `http://127.0.0.1:${port}/`

// Reproduces the SWs' fetchJson header spread verbatim.
async function swPost(headers: Record<string, string>): Promise<void> {
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: "{}",
  })
}

function outboxEntry(
  traceparent: string | undefined,
  createdAt: string
): PendingOutboxMessage {
  return {
    clientMessageId: "m1",
    conversationId: "c1",
    contentBlocks: [],
    createdAt,
    optimisticSequence: 1,
    status: "sending",
    attemptCount: 0,
    ...(traceparent ? { traceparent } : {}),
  }
}

async function flushOne(entry: PendingOutboxMessage) {
  seen.length = 0
  const result = await flushOutboxQueue(
    { clientInstanceId: "ci", outbox: { [entry.clientMessageId]: entry } },
    {
      now: () => nowIso(),
      // The SW-shape send: the outbox POST replays off createdAt.
      send: async (e) => swPost(replayTraceHeaders(e.traceparent, e.createdAt)),
    }
  )
  return result
}

// ── outbox: fresh valid carrier ⇒ exactly one traceparent equal to persisted
{
  const result = await flushOne(outboxEntry(VALID, nowIso()))
  check(
    "outbox fresh: sends exactly one traceparent equal to the persisted carrier",
    seen.length === 1 && seen[0] === VALID,
    seen
  )
  check(
    "outbox fresh: the sent entry is removed from the queue",
    Object.keys(result.outbox).length === 0
  )
}

// ── outbox: >24h carrier ⇒ no header
{
  await flushOne(outboxEntry(VALID, agoIso(25 * 60 * 60 * 1000)))
  check(
    "outbox >24h: sends no traceparent header",
    seen.length === 1 && seen[0] === undefined,
    seen
  )
}

// ── outbox: malformed persisted carrier ⇒ no header
{
  await flushOne(outboxEntry("not-a-traceparent", nowIso()))
  check(
    "outbox malformed: sends no traceparent header",
    seen.length === 1 && seen[0] === undefined,
    seen
  )
}

// ── read-watermark path: identical behaviour off updatedAt
{
  seen.length = 0
  await swPost(replayTraceHeaders(VALID, nowIso())) // fresh
  await swPost(replayTraceHeaders(VALID, agoIso(25 * 60 * 60 * 1000))) // stale
  check(
    "read-watermark: fresh sends the carrier, >24h sends none (off updatedAt)",
    seen.length === 2 && seen[0] === VALID && seen[1] === undefined,
    seen
  )
}

// ── api-side W3C extract of the replayed header yields the original trace+span
{
  const extracted = trace.getSpanContext(
    new W3CTraceContextPropagator().extract(
      ROOT_CONTEXT,
      { traceparent: VALID },
      defaultTextMapGetter
    )
  )
  check(
    "api extract: replayed header resolves to the original trace + span id",
    extracted?.traceId === VALID.slice(3, 35) &&
      extracted?.spanId === VALID.slice(36, 52),
    extracted
  )
}

await new Promise<void>((resolve) => server.close(() => resolve()))
context.disable()
finish("P-B2")
