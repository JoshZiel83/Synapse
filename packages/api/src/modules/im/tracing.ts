// IM socket-mode inbound spans (docs/trace-correctness-remediation-plan-
// 2026-07-12.md §4.I change 6).
//
// Long-connection connectors (telegram long-poll, dingtalk Stream, Baileys,
// weixin ilink, …) deliver messages over connections the api DIALED — there is
// no HTTP SERVER span and no inbound carrier, so without this wrapper an
// IM-originated turn is trace-dark: `session/repo.ts`'s `activeTraceparent()`
// sees no active span and `session_wakeups.origin_traceparent` stays NULL.
//
// `withImInboundSpan` opens a fresh-root CONSUMER span around the single
// `emitInbound` → `ingestInboundEnvelope` choke point (im/runtime.ts) — one
// wrapper covers every current and future `long_connection` connector.
// Webhook-mode accounts keep their HTTP SERVER spans (their ingest runs under
// the route handler, which never passes through the runtime's emitInbound —
// no double-wrap).
//
// ROOT_CONTEXT is deliberate, twice over: (a) there is no upstream trace to
// continue (the message originates on the IM platform), and parenting on the
// ambient context would attach unrelated connection-lifetime state; (b) it
// drops the `suppressTracing` context key, so an envelope emitted from inside
// a suppressed poll/maintenance scope still records.

import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api"
import type { TransportAccountSummary } from "@synapse/shared/types"

const tracer = trace.getTracer("synapse-im")

/**
 * Run one inbound-envelope ingest inside a fresh-root CONSUMER span named
 * `process ${transportKind}` (messaging-semconv naming template
 * `{operation.name} {destination}`). Errors are recorded + marked ERROR and
 * rethrown (the connector's retry/backoff semantics are unchanged); the span
 * always ends in `finally`.
 */
export async function withImInboundSpan<T>(
  account: TransportAccountSummary,
  fn: () => Promise<T>
): Promise<T> {
  return tracer.startActiveSpan(
    `process ${account.transportKind}`,
    {
      kind: SpanKind.CONSUMER,
      attributes: {
        "messaging.system": account.transportKind,
        "messaging.operation.type": "process",
        "messaging.destination.name": account.transportKind,
        "synapse.im.account_id": account.id,
        "synapse.workspace_id": account.workspaceId,
      },
    },
    ROOT_CONTEXT,
    async (span) => {
      try {
        return await fn()
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
