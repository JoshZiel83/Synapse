import { Worker } from "bullmq"
import type { Job, Processor, WorkerOptions } from "bullmq"
import {
  context,
  defaultTextMapGetter,
  defaultTextMapSetter,
  isSpanContextValid,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api"
import { W3CTraceContextPropagator } from "@opentelemetry/core"

/**
 * OpenTelemetry trace propagation across the BullMQ (Redis) boundary.
 *
 * OTel's in-process AsyncLocalStorage context CANNOT cross an enqueue → Redis →
 * worker hop (the worker picks the job up in a fresh async context, often a
 * different process). Without this, worker logs/spans would have no trace_id and
 * could never be tied to the request that enqueued the job. So we:
 *   1. inject the active W3C trace context into job data under a reserved key at
 *      enqueue time (see queues.ts — applied centrally to every `.add`), and
 *   2. extract it in `tracedWorker` and run each job inside a CONSUMER span that
 *      continues that trace.
 *
 * The carrier key is reserved and additive — every worker destructures the
 * specific fields it needs from job.data, so the extra key is ignored and no
 * payload schema changes.
 */
const CARRIER_KEY = "__otelctx"
const tracer = trace.getTracer("synapse-bullmq")
// Trace-context ONLY (no baggage). The carrier is persisted into Redis job data
// and exported to spans, so we deliberately do NOT use the global propagator —
// that includes the baggage propagator, and a future contributor setting OTel
// baggage with user/PII values would silently leak it into job payloads + logs.
const tracePropagator = new W3CTraceContextPropagator()

/**
 * Return job data with the active trace context injected (W3C traceparent/
 * tracestate) under the reserved key. No-op (returns the input unchanged) when
 * data is not a plain object or there is no active span to propagate.
 */
export function injectTraceContext<T>(data: T): T {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return data
  }
  const carrier: Record<string, string> = {}
  tracePropagator.inject(context.active(), carrier, defaultTextMapSetter)
  if (Object.keys(carrier).length === 0) return data
  return { ...(data as Record<string, unknown>), [CARRIER_KEY]: carrier } as T
}

/**
 * Run `fn` with a ROOT (span-less) OTel context so any `.add` inside it is
 * enqueued as a FRESH trace root, NOT a continuation of the currently-active
 * span.
 *
 * Use this for self-heal / fan-in requeues that are enqueued from INSIDE another
 * job's CONSUMER span but semantically start a NEW turn — e.g. the session-think
 * end-of-turn requeue that drains wakeups belonging to OTHER requests/users.
 * Without it, `injectTraceContext` (which reads `context.active()` synchronously
 * inside the queues.ts `.add` trap) would stamp the current job's trace onto the
 * requeued job, cross-attributing an unrelated user's whole turn to the wrong
 * trace. `injectTraceContext` sees ROOT_CONTEXT here → empty carrier → the
 * consumer starts a fresh root. (Fan-in upstreams are re-attached as span LINKS,
 * not as the parent — see `linkUpstreamTraces`.)
 *
 * Prefer this over a data-level "skip injection" marker: it needs no change to
 * the deliberately-dumb injection choke point and cannot silently fail the way an
 * identity-sensitive Symbol marker would under a dual ESM/CJS module load.
 */
export function withRootTrace<T>(fn: () => T): T {
  return context.with(ROOT_CONTEXT, fn)
}

/**
 * Attach a span LINK to the currently-active span for each upstream W3C
 * traceparent — the causal join for a fan-in turn that drains N wakeups from N
 * different upstream requests.
 *
 * The turn itself is a fresh root (see `withRootTrace`), so we do NOT parent it
 * under any single upstream; instead each drained wakeup's originating trace
 * (captured at enqueue time in the `session_wakeups.origin_traceparent` column)
 * becomes a LINK, preserving "which requests caused this turn" without false
 * single-parent attribution. Standard OTel messaging/batch modeling.
 *
 * No-op when OTel is off / there is no active span / a traceparent is malformed.
 * A self-link is skipped — the idle→enqueue path legitimately continues its own
 * request trace as the parent, so linking it to itself would be noise.
 */
export function linkUpstreamTraces(traceparents: Iterable<string>): void {
  const span = trace.getActiveSpan()
  if (!span) return
  const ownTraceId = span.spanContext().traceId
  for (const tp of traceparents) {
    if (!tp) continue
    const ctx = tracePropagator.extract(
      ROOT_CONTEXT,
      { traceparent: tp },
      defaultTextMapGetter
    )
    const sc = trace.getSpanContext(ctx)
    if (!sc || !isSpanContextValid(sc) || sc.traceId === ownTraceId) continue
    span.addLink({
      context: sc,
      attributes: { "synapse.link.kind": "session_wakeup" },
    })
  }
}

type AnyJob = Job<unknown, unknown, string>

/**
 * Wrap a BullMQ processor so each job runs inside a CONSUMER span that continues
 * the trace captured at enqueue time (or starts a fresh trace if none). Worker
 * logs emitted within then carry the right trace_id via the logger mixin.
 */
function withJobSpan(
  queueName: string,
  processor: Processor<unknown, unknown, string>
): Processor<unknown, unknown, string> {
  return (job: AnyJob, token?: string) => {
    const data = job.data
    const carrier =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)[CARRIER_KEY]
        : undefined
    const parent =
      carrier && typeof carrier === "object"
        ? tracePropagator.extract(
            context.active(),
            carrier as Record<string, string>,
            defaultTextMapGetter
          )
        : context.active()

    return context.with(parent, () =>
      tracer.startActiveSpan(
        `bullmq ${queueName} process`,
        {
          kind: SpanKind.CONSUMER,
          attributes: {
            "messaging.system": "bullmq",
            "messaging.operation": "process",
            "messaging.destination.name": queueName,
            "messaging.message.id": job.id ?? "",
          },
        },
        async (span) => {
          try {
            const result = await processor(job, token)
            span.end()
            return result
          } catch (err) {
            span.recordException(err as Error)
            span.setStatus({ code: SpanStatusCode.ERROR })
            span.end()
            throw err
          }
        }
      )
    )
  }
}

/**
 * Drop-in replacement for `new Worker(name, processor, opts)` that traces every
 * job (see withJobSpan). Use this instead of `new Worker` for all Synapse
 * workers so worker logs/spans correlate with the enqueueing request. Generics
 * mirror BullMQ's own `any` defaults so existing worker bodies (which read
 * `job.data` untyped) keep compiling unchanged.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function tracedWorker<
  DataType = any,
  ResultType = any,
  NameType extends string = string,
>(
  name: string,
  processor: Processor<DataType, ResultType, NameType>,
  opts?: WorkerOptions
): Worker<DataType, ResultType, NameType> {
  const wrapped = withJobSpan(
    name,
    processor as unknown as Processor<unknown, unknown, string>
  ) as unknown as Processor<DataType, ResultType, NameType>
  return new Worker<DataType, ResultType, NameType>(name, wrapped, opts)
}
/* eslint-enable @typescript-eslint/no-explicit-any */
