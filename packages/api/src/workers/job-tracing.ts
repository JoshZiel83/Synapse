import { Worker } from "bullmq"
import type { Job, Processor, WorkerOptions } from "bullmq"
import {
  context,
  defaultTextMapGetter,
  defaultTextMapSetter,
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
