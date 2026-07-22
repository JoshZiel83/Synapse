import { test } from "node:test"
import assert from "node:assert/strict"
import {
  context,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api"
import type { TraceState } from "@opentelemetry/api"
import type { Job } from "bullmq"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { hrTimeToMilliseconds, suppressTracing } from "@opentelemetry/core"
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import {
  injectTraceContext,
  linkUpstreamTraces,
  sendWithProducerSpan,
  withJobSpan,
  withRootTrace,
  wrapTickProcessor,
} from "./job-tracing.js"

// Register a real context manager so `context.with(...)` actually propagates the
// active span context (the API's default noop manager ignores it). Each test
// file runs in its own process under `tsx --test`, so this global is isolated.
context.setGlobalContextManager(new AsyncLocalStorageContextManager())

// Register a real global provider with an in-memory exporter: job-tracing.ts
// resolves its tracer through the global API (ProxyTracer), so this makes the
// module's spans observable/assertable — required for the tick-worker matrix,
// where the assertion IS "which spans got exported".
const tickExporter = new InMemorySpanExporter()
trace.setGlobalTracerProvider(
  new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(tickExporter)],
  })
)

// A context carrying a valid (non-zero, correct-length) remote span context —
// stands in for "an active enqueuer span".
const activeCtx = trace.setSpanContext(ROOT_CONTEXT, {
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  traceFlags: 1,
  isRemote: false,
})

/**
 * A validation-FREE TraceState, faithful to @sentry/opentelemetry's vendored
 * implementation (its `set()` never validates, which is exactly how the
 * grammar-invalid `sentry.dsc=k=v,...` members enter a span context — the C9c
 * corruption source). @opentelemetry/core's own TraceState cannot stand in
 * here: its `set()` validates and silently DROPS `sentry.dsc`, which would
 * make these tests vacuously green.
 */
function sentryStyleTraceState(
  entries: ReadonlyArray<readonly [string, string]>
): TraceState {
  const map = new Map(entries)
  return {
    get: (key) => map.get(key),
    set: (key, value) =>
      sentryStyleTraceState([
        ...[...map].filter(([k]) => k !== key),
        [key, value],
      ]),
    unset: (key) => sentryStyleTraceState([...map].filter(([k]) => k !== key)),
    serialize: () => [...map].map(([k, v]) => `${k}=${v}`).join(","),
  }
}

/** activeCtx variant whose span context carries the given tracestate members. */
function ctxWithTraceState(entries: ReadonlyArray<readonly [string, string]>) {
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    traceFlags: 1,
    isRemote: false,
    traceState: sentryStyleTraceState(entries),
  })
}

// Without any OpenTelemetry provider/propagator registered (as in a bare unit
// context), injectTraceContext must be a safe no-op: it never mutates payload
// shape, so it can never break a worker's job.data schema.

test("injectTraceContext returns non-objects unchanged", () => {
  assert.equal(injectTraceContext(null), null)
  assert.equal(injectTraceContext(undefined), undefined)
  assert.equal(injectTraceContext(5), 5)
  assert.deepEqual(injectTraceContext([1, 2]), [1, 2])
})

test("injectTraceContext leaves object data unchanged when no active span", () => {
  const data = { sessionId: "s1", actorId: "a1", workspaceId: "w1" }
  const out = injectTraceContext(data)
  assert.deepEqual(out, data)
  assert.ok(!("__otelctx" in (out as Record<string, unknown>)))
})

test("injectTraceContext injects __otelctx when a span is active", () => {
  context.with(activeCtx, () => {
    const out = injectTraceContext({ sessionId: "s1" }) as Record<
      string,
      unknown
    >
    assert.ok("__otelctx" in out, "expected trace carrier under an active span")
    const carrier = out.__otelctx as Record<string, string>
    assert.match(carrier.traceparent, /^00-0af7651916cd43dd8448eb211c80319c-/)
  })
})

test("withRootTrace strips the active trace so the requeue is a fresh root", () => {
  context.with(activeCtx, () => {
    // Same enqueue, but rooted: injectTraceContext sees ROOT_CONTEXT → no carrier.
    const out = withRootTrace(() =>
      injectTraceContext({ sessionId: "s1" })
    ) as Record<string, unknown>
    assert.ok(
      !("__otelctx" in out),
      "rooted enqueue must NOT inherit the active (possibly other-user) trace"
    )
  })
})

test("withRootTrace returns the wrapped fn's value", () => {
  assert.equal(
    withRootTrace(() => 42),
    42
  )
})

// ─── tracedTickWorker matrix (via its unit seam, wrapTickProcessor) ───
//
// P-TICK policy: a no-op tick exports ZERO spans; a found-work tick exports ONE
// backdated `process {name}` CONSUMER summary span; an error tick exports the
// same span with ERROR + exception, then rethrows.

// The tick processors under test ignore the job argument entirely (like the
// real schedulers/sweepers) — a bare stub is sufficient.
const fakeJob = {} as Job
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("tick worker: no-op tick exports ZERO spans, even for spans started inside", async () => {
  tickExporter.reset()
  const wrapped = wrapTickProcessor(
    "test-tick",
    async () => {
      // A span started inside the tick (stand-in for future pg/ioredis/undici
      // auto-instrumentation) must come back non-recording under suppression —
      // this is what makes the zero-span guarantee future-proof.
      const inner = trace.getTracer("tick-test").startSpan("inner-work")
      assert.equal(
        inner.isRecording(),
        false,
        "span inside suppressed tick must be non-recording"
      )
      inner.end()
      return { scheduledExecutions: [] as string[] }
    },
    { hasWork: (r) => r.scheduledExecutions.length > 0 }
  )
  const result = await wrapped(fakeJob)
  assert.deepEqual(result, { scheduledExecutions: [] })
  assert.equal(
    tickExporter.getFinishedSpans().length,
    0,
    "a no-op tick must export zero spans"
  )
})

test("tick worker: found-work tick exports ONE backdated CONSUMER summary span", async () => {
  tickExporter.reset()
  const wrapped = wrapTickProcessor(
    "test-tick",
    async () => {
      await sleep(30)
      return { scheduledExecutions: ["e1", "e2", "e3"] }
    },
    {
      hasWork: (r) => r.scheduledExecutions.length > 0,
      workCount: (r) => r.scheduledExecutions.length,
    }
  )
  await wrapped(fakeJob)
  const spans = tickExporter.getFinishedSpans()
  assert.equal(spans.length, 1, "exactly one summary span")
  const span = spans[0]!
  assert.equal(span.name, "process test-tick")
  assert.equal(span.kind, SpanKind.CONSUMER)
  assert.equal(
    span.parentSpanContext,
    undefined,
    "summary span is a fresh root"
  )
  assert.equal(span.attributes["synapse.tick.items"], 3)
  assert.equal(span.attributes["messaging.system"], "bullmq")
  assert.equal(span.attributes["messaging.destination.name"], "test-tick")
  // Backdated: startTime predates the processor's work, so the ended span's
  // duration covers the full tick (not ~0ms from a start-at-end span).
  assert.ok(
    hrTimeToMilliseconds(span.duration) >= 20,
    `summary span duration must cover the tick's work, got ${hrTimeToMilliseconds(span.duration)}ms`
  )
})

test("tick worker: hasWork=false result stays span-free even with workCount wired", async () => {
  tickExporter.reset()
  const wrapped = wrapTickProcessor(
    "test-tick",
    async () => ({ rechecked: 0 }),
    {
      hasWork: (r) => (r.rechecked ?? 0) > 0,
      workCount: (r) => r.rechecked ?? 0,
    }
  )
  await wrapped(fakeJob)
  assert.equal(tickExporter.getFinishedSpans().length, 0)
})

test("tick worker: error tick emits the backdated span with ERROR + exception, and rethrows", async () => {
  tickExporter.reset()
  const boom = new Error("tick exploded")
  const wrapped = wrapTickProcessor(
    "test-tick",
    // Explicit result annotation: a throw-only body would otherwise infer
    // Promise<never> and poison the Job generic.
    async (): Promise<{ rechecked: number }> => {
      await sleep(30)
      throw boom
    },
    { hasWork: () => false } // hasWork is irrelevant on the throw path
  )
  await assert.rejects(
    () => wrapped(fakeJob),
    boom,
    "the error must surface to BullMQ unchanged (retry/failed semantics)"
  )
  const spans = tickExporter.getFinishedSpans()
  assert.equal(
    spans.length,
    1,
    "error ticks DO emit a span — failures are signal"
  )
  const span = spans[0]!
  assert.equal(span.name, "process test-tick")
  assert.equal(span.kind, SpanKind.CONSUMER)
  assert.equal(span.status.code, SpanStatusCode.ERROR)
  const exception = span.events.find((e) => e.name === "exception")
  assert.ok(exception, "recordException must attach an exception event")
  assert.equal(exception.attributes?.["exception.message"], "tick exploded")
  assert.ok(
    hrTimeToMilliseconds(span.duration) >= 20,
    "error span is backdated too — duration covers the failed tick"
  )
})

test("tick worker: enqueue INSIDE the suppressed scope injects an EMPTY carrier (even under a valid span context)", async () => {
  tickExporter.reset()
  const carriers: Array<Record<string, unknown>> = []
  const wrapped = wrapTickProcessor(
    "test-tick",
    async () => {
      // A work-path enqueue that FORGOT withRootTrace: the suppression key
      // must make propagator inject a no-op (W3CTraceContextPropagator bails
      // on isTracingSuppressed), so tick-trace garbage is never stamped into
      // Redis job data — the inject half of the suppression contract.
      carriers.push(injectTraceContext({ x: 1 }) as Record<string, unknown>)
      // Even with a VALID span context re-bound inside the suppressed scope,
      // inject must stay empty: suppression wins over span-context presence.
      context.with(
        trace.setSpanContext(context.active(), {
          traceId: "0af7651916cd43dd8448eb211c80319c",
          spanId: "b7ad6b7169203331",
          traceFlags: 1,
          isRemote: true,
        }),
        () => {
          carriers.push(injectTraceContext({ x: 2 }) as Record<string, unknown>)
        }
      )
      return { scheduledExecutions: ["e1"] }
    },
    {
      hasWork: (r) => r.scheduledExecutions.length > 0,
      workCount: (r) => r.scheduledExecutions.length,
    }
  )
  await wrapped(fakeJob)
  assert.equal(carriers.length, 2)
  for (const carrier of carriers) {
    assert.ok(
      !("__otelctx" in carrier),
      "suppressed-scope enqueue must inject an EMPTY carrier"
    )
  }
  // ...while the found-work summary span still exports.
  assert.equal(tickExporter.getFinishedSpans().length, 1)
})

test("tick worker: repeat found-work ticks emit DISTINCT parentless roots (no stale-context inheritance)", async () => {
  tickExporter.reset()
  const wrapped = wrapTickProcessor(
    "test-tick",
    async () => ({ scheduledExecutions: ["e1"] }),
    { hasWork: (r) => r.scheduledExecutions.length > 0 }
  )
  // The SAME wrapped processor invoked twice — a refactor hoisting
  // suppressTracing(context.active()) into the wrapper closure (the long-poll
  // idiom) would inherit ambient state across ticks and fail here.
  await wrapped(fakeJob)
  await wrapped(fakeJob)
  const spans = tickExporter.getFinishedSpans()
  assert.equal(spans.length, 2, "one summary span per found-work tick")
  for (const span of spans) {
    assert.equal(
      span.parentSpanContext,
      undefined,
      "each summary is parentless"
    )
  }
  assert.notEqual(
    spans[0]!.spanContext().traceId,
    spans[1]!.spanContext().traceId,
    "each tick is its own fresh trace root"
  )
})

test("tick worker: a foreign ambient span context cannot leak into the tick", async () => {
  tickExporter.reset()
  const foreignTraceId = "1af7651916cd43dd8448eb211c80319d"
  let sawActiveSpan: boolean | undefined
  let innerRecording: boolean | undefined
  const wrapped = wrapTickProcessor(
    "test-tick",
    async () => {
      sawActiveSpan = trace.getSpan(context.active()) !== undefined
      const inner = trace.getTracer("tick-test").startSpan("ambient-leak-probe")
      innerRecording = inner.isRecording()
      inner.end()
      return { scheduledExecutions: ["e1"] }
    },
    { hasWork: (r) => r.scheduledExecutions.length > 0 }
  )
  // The BullMQ callback arrives with a stale/foreign ambient span context
  // (stand-in for ALS bleed from an unrelated request).
  await context.with(
    trace.setSpanContext(ROOT_CONTEXT, {
      traceId: foreignTraceId,
      spanId: "c7ad6b7169203332",
      traceFlags: 1,
      isRemote: true,
    }),
    () => wrapped(fakeJob)
  )
  assert.equal(
    sawActiveSpan,
    false,
    "processor must not see the callback's ambient span"
  )
  assert.equal(innerRecording, false, "processor context must be suppressed")
  const spans = tickExporter.getFinishedSpans()
  assert.equal(spans.length, 1)
  assert.equal(
    spans[0]!.parentSpanContext,
    undefined,
    "summary stays parentless"
  )
  assert.notEqual(
    spans[0]!.spanContext().traceId,
    foreignTraceId,
    "summary must not join the foreign trace"
  )
})

test("withRootTrace escapes suppressTracing (the tick work-path enqueue escape hatch)", () => {
  tickExporter.reset()
  context.with(suppressTracing(ROOT_CONTEXT), () => {
    const suppressed = trace.getTracer("tick-test").startSpan("suppressed")
    assert.equal(suppressed.isRecording(), false)
    suppressed.end()
    withRootTrace(() => {
      // This is how a tick's work-path enqueues become their own trace roots:
      // ROOT_CONTEXT carries no suppression key, so spans record again.
      const escaped = trace.getTracer("tick-test").startSpan("escaped")
      assert.equal(
        escaped.isRecording(),
        true,
        "withRootTrace must drop the suppression key"
      )
      escaped.end()
    })
  })
  const names = tickExporter.getFinishedSpans().map((s) => s.name)
  assert.deepEqual(names, ["escaped"])
})

// ─── sendWithProducerSpan (the `send {q}` PRODUCER half, §4.H change 1) ───

test("sendWithProducerSpan: carrier is the PRODUCER span's own context; consumer would parent to it", async () => {
  tickExporter.reset()
  let injected: Record<string, string> | undefined
  const job = await context.with(activeCtx, () =>
    sendWithProducerSpan(
      "test-queue",
      "think",
      { sessionId: "s1" },
      async (dataWithCtx) => {
        injected = (dataWithCtx as Record<string, unknown>).__otelctx as
          | Record<string, string>
          | undefined
        return { id: "job-42" }
      }
    )
  )
  assert.deepEqual(job, { id: "job-42" }, "add()'s result must pass through")
  const spans = tickExporter.getFinishedSpans()
  assert.equal(spans.length, 1, "exactly one producer span")
  const producer = spans[0]!
  assert.equal(producer.name, "send test-queue")
  assert.equal(producer.kind, SpanKind.PRODUCER)
  // Pinned wire names — the semconv constants must resolve to exactly these.
  assert.equal(producer.attributes["messaging.system"], "bullmq")
  assert.equal(producer.attributes["messaging.operation.type"], "send")
  assert.equal(producer.attributes["messaging.operation.name"], "send")
  assert.equal(producer.attributes["messaging.destination.name"], "test-queue")
  assert.equal(producer.attributes["messaging.bullmq.job.name"], "think")
  assert.equal(
    producer.attributes["messaging.message.id"],
    "job-42",
    "message id comes from the RETURNED Job"
  )
  assert.equal(
    "messaging.operation" in producer.attributes,
    false,
    "deprecated bare messaging.operation must not reappear"
  )
  // Creation-context pattern: the carrier is injected INSIDE the callback, so
  // its span-id IS the producer's — the worker-side CONSUMER span extracting
  // this carrier parents directly to the producer.
  assert.ok(injected, "carrier must be injected")
  const producerSc = producer.spanContext()
  assert.equal(
    injected.traceparent,
    `00-${producerSc.traceId}-${producerSc.spanId}-01`
  )
  // ...and the producer itself continues the enqueuer's trace.
  assert.equal(producerSc.traceId, "0af7651916cd43dd8448eb211c80319c")
  assert.equal(producer.parentSpanContext?.spanId, "b7ad6b7169203331")
})

test("sendWithProducerSpan under withRootTrace: fresh parentless producer ROOT, carrier still non-empty", async () => {
  tickExporter.reset()
  let injected: Record<string, string> | undefined
  await context.with(activeCtx, () =>
    withRootTrace(() =>
      sendWithProducerSpan("test-queue", "think", { s: 1 }, async (d) => {
        injected = (d as Record<string, unknown>).__otelctx as
          | Record<string, string>
          | undefined
        return { id: "j1" }
      })
    )
  )
  const spans = tickExporter.getFinishedSpans()
  assert.equal(spans.length, 1)
  const producer = spans[0]!
  assert.equal(
    producer.parentSpanContext,
    undefined,
    "rooted enqueue's producer is parentless"
  )
  assert.notEqual(
    producer.spanContext().traceId,
    "0af7651916cd43dd8448eb211c80319c",
    "rooted enqueue must NOT continue the ambient (other-user) trace"
  )
  assert.ok(injected, "rooted enqueue still injects the producer-root carrier")
  assert.match(
    injected.traceparent,
    new RegExp(`^00-${producer.spanContext().traceId}-`)
  )
})

test("sendWithProducerSpan: enqueue failure ⇒ ERROR + exception event, error rethrown unchanged", async () => {
  tickExporter.reset()
  const boom = new Error("redis down")
  await assert.rejects(
    () =>
      context.with(activeCtx, () =>
        sendWithProducerSpan("test-queue", "think", { s: 1 }, async () => {
          throw boom
        })
      ),
    boom,
    "the enqueue error must surface to the caller unchanged"
  )
  const spans = tickExporter.getFinishedSpans()
  assert.equal(spans.length, 1, "the failed enqueue still exports its span")
  const producer = spans[0]!
  assert.equal(producer.status.code, SpanStatusCode.ERROR)
  const exception = producer.events.find((e) => e.name === "exception")
  assert.ok(exception, "recordException must attach an exception event")
  assert.equal(exception.attributes?.["exception.message"], "redis down")
  assert.equal(
    "messaging.message.id" in producer.attributes,
    false,
    "no message id on a failed enqueue — there is no Job"
  )
})

// ─── withJobSpan (the `process {q}` CONSUMER half, §4.H — via its unit seam) ───
//
// Drives the SAME wrapped processor a Redis-backed tracedWorker would run,
// with a stub Job — pinning the producer→consumer parenting, the wait_time_ms
// dwell formula (the guard-annotated `processedOn ?? Date.now()` line), the
// semconv attribute names, and the error path.

/** Stub Job with the fields withJobSpan reads. */
function stubJob(overrides: Partial<Job> & { data?: unknown } = {}): Job {
  return {
    id: "job-7",
    data: {},
    timestamp: 1_000,
    processedOn: 1_250,
    delay: 0,
    attemptsMade: 0,
    ...overrides,
  } as unknown as Job
}

test("withJobSpan: consumer span parents DIRECTLY to a real sendWithProducerSpan producer", async () => {
  tickExporter.reset()
  // Producer half: a REAL enqueue-side carrier minted inside the producer span.
  let dataWithCarrier: unknown
  await context.with(activeCtx, () =>
    sendWithProducerSpan(
      "test-queue",
      "think",
      { sessionId: "s1" },
      async (d) => {
        dataWithCarrier = d
        return { id: "job-7" }
      }
    )
  )
  const producer = tickExporter.getFinishedSpans()[0]!
  assert.equal(producer.name, "send test-queue")

  // Consumer half: withJobSpan extracts the carrier from job.data.
  const wrapped = withJobSpan("test-queue", async () => "done")
  const result = await wrapped(stubJob({ data: dataWithCarrier }))
  assert.equal(result, "done")

  const consumer = tickExporter
    .getFinishedSpans()
    .find((s) => s.name === "process test-queue")
  assert.ok(consumer, "consumer span must export")
  assert.equal(consumer.kind, SpanKind.CONSUMER)
  assert.equal(
    consumer.spanContext().traceId,
    producer.spanContext().traceId,
    "consumer continues the producer's trace"
  )
  assert.equal(
    consumer.parentSpanContext?.spanId,
    producer.spanContext().spanId,
    "consumer parents DIRECTLY to the producer span (carrier = producer ctx)"
  )
})

test("withJobSpan: an invalid/duplicate/oversized/Level-2-only __otelctx.tracestate continues the producer trace with the tracestate dropped WHOLE", async () => {
  const TP = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
  const traceId = "0af7651916cd43dd8448eb211c80319c"
  for (const bad of [
    "Foo=bar", // grammar-invalid: gated out before extract
    "ok=1,ok=2", // duplicate key: gated out before extract
    `v=${"x".repeat(512)}`, // over the 512 cap: gated out before extract
    "ok=1,1abc=2", // Level-2-only key: passes the gate, OTel-JS salvages, stage 3 drops
  ]) {
    tickExporter.reset()
    const wrapped = withJobSpan("test-queue", async () => "done")
    await wrapped(
      stubJob({ data: { __otelctx: { traceparent: TP, tracestate: bad } } })
    )
    const consumer = tickExporter
      .getFinishedSpans()
      .find((s) => s.name === "process test-queue")
    assert.ok(consumer, bad)
    assert.equal(
      consumer.spanContext().traceId,
      traceId,
      `continues producer trace: ${bad}`
    )
    assert.equal(
      consumer.spanContext().traceState?.serialize() || "",
      "",
      `tracestate dropped whole (never partially salvaged): ${bad}`
    )
  }
})

test("withJobSpan: a CLEAN __otelctx.tracestate rides through to the consumer span", async () => {
  const TP = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
  tickExporter.reset()
  const wrapped = withJobSpan("test-queue", async () => "done")
  await wrapped(
    stubJob({
      data: { __otelctx: { traceparent: TP, tracestate: "ok=1,congo=t61" } },
    })
  )
  const consumer = tickExporter
    .getFinishedSpans()
    .find((s) => s.name === "process test-queue")
  assert.ok(consumer)
  assert.equal(consumer.spanContext().traceState?.get("ok"), "1")
  assert.equal(consumer.spanContext().traceState?.get("congo"), "t61")
})

test("withJobSpan: semconv attribute names — operation.type/name present, deprecated bare messaging.operation absent", async () => {
  tickExporter.reset()
  const wrapped = withJobSpan("test-queue", async () => undefined)
  await wrapped(stubJob())
  const consumer = tickExporter.getFinishedSpans()[0]!
  assert.equal(consumer.name, "process test-queue")
  assert.equal(consumer.attributes["messaging.system"], "bullmq")
  assert.equal(consumer.attributes["messaging.operation.type"], "process")
  assert.equal(consumer.attributes["messaging.operation.name"], "process")
  assert.equal(consumer.attributes["messaging.destination.name"], "test-queue")
  assert.equal(consumer.attributes["messaging.message.id"], "job-7")
  assert.equal(
    "messaging.operation" in consumer.attributes,
    false,
    "deprecated bare messaging.operation must not reappear"
  )
})

test("withJobSpan: wait_time_ms = processedOn - timestamp - delay, clamped at 0, now-defaulted without processedOn", async () => {
  // exact dwell
  tickExporter.reset()
  await withJobSpan(
    "q",
    async () => undefined
  )(stubJob({ timestamp: 1_000, processedOn: 1_250, delay: 50 }))
  let span = tickExporter.getFinishedSpans().at(-1)!
  assert.equal(span.attributes["messaging.bullmq.job.wait_time_ms"], 200)
  assert.equal(span.attributes["messaging.bullmq.job.attempts_made"], 0)

  // clock skew / delayed job picked up early ⇒ clamped, never negative
  tickExporter.reset()
  await withJobSpan(
    "q",
    async () => undefined
  )(stubJob({ timestamp: 1_000, processedOn: 1_100, delay: 5_000 }))
  span = tickExporter.getFinishedSpans().at(-1)!
  assert.equal(
    span.attributes["messaging.bullmq.job.wait_time_ms"],
    0,
    "max(0, ...) clamp — dwell is never negative"
  )

  // missing processedOn ⇒ the deliberate Date.now() default (a sane dwell
  // against a recent enqueue timestamp, still never negative)
  tickExporter.reset()
  const enqueuedAt = Date.now() - 100
  await withJobSpan(
    "q",
    async () => undefined
  )(stubJob({ timestamp: enqueuedAt, processedOn: undefined, delay: 0 }))
  span = tickExporter.getFinishedSpans().at(-1)!
  const dwell = span.attributes["messaging.bullmq.job.wait_time_ms"]
  assert.equal(typeof dwell, "number")
  assert.ok(
    (dwell as number) >= 100 && (dwell as number) < 60_000,
    `now-defaulted dwell must be plausible, got ${String(dwell)}`
  )

  // retried job surfaces attempts_made
  tickExporter.reset()
  await withJobSpan("q", async () => undefined)(stubJob({ attemptsMade: 3 }))
  span = tickExporter.getFinishedSpans().at(-1)!
  assert.equal(span.attributes["messaging.bullmq.job.attempts_made"], 3)
})

test("withJobSpan: no/garbage carrier ⇒ fresh root; processor throw ⇒ ERROR + exception + rethrow", async () => {
  // no carrier ⇒ parentless root
  tickExporter.reset()
  await withJobSpan("q", async () => undefined)(stubJob({ data: { x: 1 } }))
  let span = tickExporter.getFinishedSpans()[0]!
  assert.equal(span.parentSpanContext, undefined, "no carrier ⇒ fresh root")

  // throwing processor ⇒ ERROR + exception event, error rethrown unchanged
  tickExporter.reset()
  const boom = new Error("worker exploded")
  await assert.rejects(
    () =>
      withJobSpan("q", async () => {
        throw boom
      })(stubJob()),
    boom,
    "the processor error must surface to BullMQ unchanged (retry semantics)"
  )
  span = tickExporter.getFinishedSpans()[0]!
  assert.equal(span.status.code, SpanStatusCode.ERROR)
  const exception = span.events.find((e) => e.name === "exception")
  assert.ok(exception, "recordException must attach an exception event")
  assert.equal(exception.attributes?.["exception.message"], "worker exploded")
})

// ─── injectTraceContext two-stage tracestate sanitizer (§3c / §4.H) ───

test("injectTraceContext scrubs Sentry tracestate members, keeping legitimate vendors (stage 1)", () => {
  context.with(
    ctxWithTraceState([
      ["sentry.dsc", "k=v,k2=v2"],
      ["othervendor", "xyz"],
    ]),
    () => {
      const out = injectTraceContext({ x: 1 }) as Record<string, unknown>
      const carrier = out.__otelctx as Record<string, string>
      assert.equal(
        carrier.tracestate,
        "othervendor=xyz",
        "sentry.dsc must be scrubbed at mint; the legitimate vendor survives"
      )
      assert.match(carrier.traceparent, /^00-0af7651916cd43dd8448eb211c80319c-/)
    }
  )
})

test("injectTraceContext: all-Sentry tracestate degrades to NO tracestate key", () => {
  context.with(
    ctxWithTraceState([
      ["sentry.dsc", "k=v"],
      ["sentry.sample_rate", "1"],
    ]),
    () => {
      const out = injectTraceContext({ x: 1 }) as Record<string, unknown>
      const carrier = out.__otelctx as Record<string, string>
      assert.equal(
        "tracestate" in carrier,
        false,
        "an emptied tracestate must be ABSENT, never an empty string"
      )
      assert.ok(carrier.traceparent, "traceparent is unaffected")
    }
  )
})

test("injectTraceContext: any ABNF-invalid member drops the WHOLE header (stage 2, no partial salvage)", () => {
  context.with(
    ctxWithTraceState([
      ["othervendor", "xyz"],
      // Uppercase key — grammar-invalid per W3C §3.3.2.2, but NOT a known
      // Sentry key, so it survives stage 1 and must trip the stage-2 gate.
      ["Invalid-Key", "x"],
    ]),
    () => {
      const out = injectTraceContext({ x: 1 }) as Record<string, unknown>
      const carrier = out.__otelctx as Record<string, string>
      assert.equal(
        "tracestate" in carrier,
        false,
        "whole-or-nothing: partial salvage IS the corruption mechanism"
      )
      assert.ok(carrier.traceparent)
    }
  )
})

test("injectTraceContext passes a clean vendor tracestate through verbatim", () => {
  context.with(ctxWithTraceState([["es", "s:1.0"]]), () => {
    const out = injectTraceContext({ x: 1 }) as Record<string, unknown>
    const carrier = out.__otelctx as Record<string, string>
    assert.equal(carrier.tracestate, "es=s:1.0")
  })
})

// ─── linkUpstreamTraces hygiene (flags-00 skip + linkKind, §4.H) ───

test("linkUpstreamTraces skips flags-00 upstreams and counts them; sampled/self/malformed handling intact", () => {
  tickExporter.reset()
  trace
    .getTracer("link-test")
    .startActiveSpan("consumer", { kind: SpanKind.CONSUMER }, (span) => {
      linkUpstreamTraces([
        // sampled upstream → linked
        "00-2af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
        // UNSAMPLED upstreams: extract as VALID span contexts
        // (isSpanContextValid does not check the sampled bit), but a link to a
        // head-sampled backend's unsampled trace can never resolve → skipped.
        "00-3af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00",
        "00-4af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00",
        // self-link → skipped silently (not an unsampled skip)
        `00-${span.spanContext().traceId}-b7ad6b7169203331-01`,
        // malformed → skipped silently
        "garbage",
        "",
      ])
      span.end()
    })
  const spans = tickExporter.getFinishedSpans()
  assert.equal(spans.length, 1)
  const consumer = spans[0]!
  assert.equal(consumer.links.length, 1, "only the sampled upstream links")
  assert.equal(
    consumer.links[0]!.context.traceId,
    "2af7651916cd43dd8448eb211c80319c"
  )
  assert.equal(
    consumer.links[0]!.attributes?.["synapse.link.kind"],
    "session_wakeup",
    "default linkKind"
  )
  assert.equal(
    consumer.attributes["synapse.wakeup.links_skipped_unsampled"],
    2,
    "exactly the two flags-00 upstreams count as skipped"
  )
})

test("linkUpstreamTraces: no skip counter attribute when nothing was skipped", () => {
  tickExporter.reset()
  trace.getTracer("link-test").startActiveSpan("consumer", (span) => {
    linkUpstreamTraces([
      "00-2af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    ])
    span.end()
  })
  const consumer = tickExporter.getFinishedSpans()[0]!
  assert.equal(
    "synapse.wakeup.links_skipped_unsampled" in consumer.attributes,
    false
  )
})

test("linkUpstreamTraces stamps a caller-provided linkKind ([adj 19])", () => {
  tickExporter.reset()
  trace.getTracer("link-test").startActiveSpan("fail-deliveries", (span) => {
    linkUpstreamTraces(
      ["00-2af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"],
      "remote_agent_delivery"
    )
    span.end()
  })
  const failSpan = tickExporter.getFinishedSpans()[0]!
  assert.equal(failSpan.links.length, 1)
  assert.equal(
    failSpan.links[0]!.attributes?.["synapse.link.kind"],
    "remote_agent_delivery"
  )
})
