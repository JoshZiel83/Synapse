import { test } from "node:test"
import assert from "node:assert/strict"
import {
  context,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api"
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
