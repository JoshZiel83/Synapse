import { test } from "node:test"
import assert from "node:assert/strict"
import { context, ROOT_CONTEXT, trace } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { injectTraceContext, withRootTrace } from "./job-tracing.js"

// Register a real context manager so `context.with(...)` actually propagates the
// active span context (the API's default noop manager ignores it). Each test
// file runs in its own process under `tsx --test`, so this global is isolated.
context.setGlobalContextManager(new AsyncLocalStorageContextManager())

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
