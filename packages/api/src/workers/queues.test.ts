import { test } from "node:test"
import assert from "node:assert/strict"
import { context, ROOT_CONTEXT, SpanKind, trace } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import type { Queue } from "bullmq"
import { lazyQueueProxy, type LazyQueue } from "./queues.js"

// ─── the `.add` Proxy trap branch (§4.H) ────────────────────────────────────
//
// A non-repeatable add goes through sendWithProducerSpan (ONE `send {q}`
// PRODUCER span + __otelctx carrier in job data); a repeatable/cron TEMPLATE
// registration is a scheduler write, not a message send — raw add, NO span,
// NO carrier (BullMQ clones the template every tick, so a one-shot carrier
// would make every future cron run "continue" one long-dead trace). Inverting
// the isRepeatable branch would re-introduce exactly that bug with all other
// gates green — these tests pin the fork.

const exporter = new InMemorySpanExporter()
trace.setGlobalTracerProvider(
  new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
)
context.setGlobalContextManager(new AsyncLocalStorageContextManager())

type RecordedAdd = {
  name: string
  data: Record<string, unknown>
  opts: unknown
}

function stubQueueProxy(): { proxied: Queue; adds: RecordedAdd[] } {
  const adds: RecordedAdd[] = []
  const stubQueue = {
    name: "test-queue",
    add: async (name: string, data: unknown, opts?: unknown) => {
      adds.push({ name, data: data as Record<string, unknown>, opts })
      return { id: "job-1" }
    },
  } as unknown as Queue
  const handle: LazyQueue = {
    get: () => stubQueue,
    isMaterialized: () => true,
  }
  return { proxied: lazyQueueProxy(handle), adds }
}

const activeCtx = trace.setSpanContext(ROOT_CONTEXT, {
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  traceFlags: 1,
  isRemote: false,
})

test("plain .add ⇒ ONE `send {q}` PRODUCER span; __otelctx carrier is the producer's own context", async () => {
  exporter.reset()
  const { proxied, adds } = stubQueueProxy()
  const job = await context.with(activeCtx, () =>
    proxied.add("think", { sessionId: "s1" })
  )
  assert.deepEqual(job, { id: "job-1" })

  const spans = exporter.getFinishedSpans()
  assert.equal(spans.length, 1, "exactly one producer span")
  const producer = spans[0]!
  assert.equal(producer.name, "send test-queue")
  assert.equal(producer.kind, SpanKind.PRODUCER)
  assert.equal(producer.attributes["messaging.bullmq.job.name"], "think")

  assert.equal(adds.length, 1)
  const carrier = adds[0]!.data.__otelctx as Record<string, string>
  assert.ok(carrier, "job data must carry the __otelctx carrier")
  const sc = producer.spanContext()
  assert.equal(
    carrier.traceparent,
    `00-${sc.traceId}-${sc.spanId}-01`,
    "the carrier is the PRODUCER span's own context (consumer parents to it)"
  )
})

test("repeatable template .add ⇒ raw add: ZERO spans, NO __otelctx (even under an active span)", async () => {
  exporter.reset()
  const { proxied, adds } = stubQueueProxy()
  await context.with(activeCtx, () =>
    proxied.add(
      "tick",
      { kind: "sweep" },
      { repeat: { every: 15_000 }, jobId: "sweeper" }
    )
  )
  assert.equal(
    exporter.getFinishedSpans().length,
    0,
    "a scheduler-template registration is not a message send"
  )
  assert.equal(adds.length, 1)
  assert.equal(
    "__otelctx" in adds[0]!.data,
    false,
    "no one-shot carrier on a template BullMQ clones for every future tick"
  )
  assert.deepEqual(adds[0]!.opts, {
    repeat: { every: 15_000 },
    jobId: "sweeper",
  })
})

test("non-add properties pass through bound to the underlying queue", async () => {
  const { proxied } = stubQueueProxy()
  assert.equal(proxied.name, "test-queue")
})
