// Per-frame tracing for the device control-plane `device.task.*` lifecycle
// persists (docs/trace-correctness-remediation-plan-2026-07-12.md §4.D change
// 6). The runtime echoes the api dispatch's `{traceparent, tracestate}` back
// on each task frame (RuntimeTaskRefParamsSchema); extracting it here and
// running the persist chain inside a SERVER span is what reconnects the
// severed device-tool leg: `persistTaskResult` awaits the session-wakeup
// insert + queue nudge synchronously, so `session/repo.ts` `activeTraceparent()`
// and the BullMQ `injectTraceContext` capture the dispatch trace with zero
// changes to those files.

import {
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
} from "@opentelemetry/api"
import { extractEnvelopeTraceContext } from "../../infrastructure/observability/envelope-trace.js"
import type { PersistResult } from "./control-plane-events.js"

const tracer = trace.getTracer("synapse-device-control-plane")

/** The slice of the control-plane ConnectionState the span attributes need. */
interface AuthenticatedFrameState {
  authenticatedRuntimeId: string | null
  authenticatedServiceId: string | null
}

// rawParams is PRE-zod (extractEnvelopeTraceContext re-validates the trace
// fields for the same reason); ref fields only become attributes when they
// look like ids, so a hostile frame can't stuff megabytes into a span.
function refAttribute(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 64
    ? value
    : undefined
}

/**
 * Run one `device.task.*` frame's persist inside a SERVER span named exactly
 * the JSON-RPC method, remote-parented on the frame's envelope trace context
 * (extract-or-ROOT — never the ambient/upgrade context). A `PersistResult`
 * `ok:false` marks the span ERROR but the result is still returned (the
 * caller writes the structured JSON-RPC error); a throw records + rethrows.
 * The span always ends in `finally`.
 */
export async function runTaskFrameSpan(
  method: string,
  state: AuthenticatedFrameState,
  rawParams: unknown,
  fn: () => Promise<PersistResult>
): Promise<PersistResult> {
  const params =
    typeof rawParams === "object" && rawParams !== null
      ? (rawParams as Record<string, unknown>)
      : {}
  const attributes: Attributes = { "synapse.cp.method": method }
  if (state.authenticatedRuntimeId) {
    attributes["synapse.runtime_id"] = state.authenticatedRuntimeId
  }
  if (state.authenticatedServiceId) {
    attributes["synapse.runtime_service_id"] = state.authenticatedServiceId
  }
  const operationId = refAttribute(params.operation_id)
  if (operationId) attributes["synapse.operation_id"] = operationId
  const attemptId = refAttribute(params.attempt_id)
  if (attemptId) attributes["synapse.attempt_id"] = attemptId

  return tracer.startActiveSpan(
    method,
    { kind: SpanKind.SERVER, attributes },
    extractEnvelopeTraceContext(rawParams),
    async (span) => {
      try {
        const result = await fn()
        if (!result.ok) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: result.message,
          })
        }
        return result
      } catch (err) {
        span.recordException(err as Error)
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (err as Error).message,
        })
        throw err
      } finally {
        span.end()
      }
    }
  )
}
