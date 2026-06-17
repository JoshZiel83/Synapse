import { test } from "node:test"
import assert from "node:assert/strict"
import { injectTraceContext } from "./job-tracing.js"

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
