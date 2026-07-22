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
  TraceFlags,
} from "@opentelemetry/api"
import type { Span } from "@opentelemetry/api"
import { suppressTracing, W3CTraceContextPropagator } from "@opentelemetry/core"
import {
  ATTR_MESSAGING_DESTINATION_NAME,
  ATTR_MESSAGING_MESSAGE_ID,
  ATTR_MESSAGING_OPERATION_NAME,
  ATTR_MESSAGING_OPERATION_TYPE,
  ATTR_MESSAGING_SYSTEM,
  MESSAGING_OPERATION_TYPE_VALUE_PROCESS,
  MESSAGING_OPERATION_TYPE_VALUE_SEND,
} from "@opentelemetry/semantic-conventions/incubating"
import {
  extractTraceCarrierContext,
  sanitizeTraceState,
  sanitizeTracestateHeader,
} from "../infrastructure/observability/traceparent.js"

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
// Trace-context ONLY, via a PRIVATE W3CTraceContextPropagator — deliberately
// NOT the global propagator. The global is the FirstPartyOnlyPropagator-wrapped
// composite (instrumentation.ts): its inject() is destination-host gated and
// fails CLOSED for a span with no resolvable URL, so a Redis job-data carrier
// (no URL) would get nothing injected at all; and under Sentry-on its members
// write sentry-trace/DSC baggage that must never be persisted into Redis job
// payloads (job data is exported to spans and logs — vendor headers and any
// future contributor's baggage values would silently leak).
const tracePropagator = new W3CTraceContextPropagator()

/**
 * Return job data with the active trace context injected (W3C traceparent/
 * tracestate) under the reserved key. No-op (returns the input unchanged) when
 * data is not a plain object or there is no active span to propagate.
 *
 * The carrier's `tracestate` goes through BOTH stages of the canonical
 * sanitizer (§3c; observability/traceparent.ts — imported, no local copies):
 *
 * - Stage 1 (at mint): the inject context is rebuilt with Sentry's non-W3C
 *   TraceState keys unset. Under Sentry-ON, `sentry.dsc=k=v,k2=v2` in the
 *   active span's traceState is grammar-INVALID as a serialized member (the
 *   key contains `.`, the value embeds `=`/`,`), and a compliant receiver
 *   re-parses it into junk top-level vendor keys — the C9c corruption,
 *   runtime-reproduced. Sentry DSC continuity rides its own `sentry-trace`/
 *   `baggage` headers and never belongs in Redis job data.
 * - Stage 2 (final gate): whole-or-nothing W3C §3.3.2 ABNF validation of the
 *   serialized header — ANY invalid member drops the whole header (partial
 *   salvage IS the corruption mechanism); legitimate vendor members
 *   (`es=s:1.0`) pass verbatim.
 */
export function injectTraceContext<T>(data: T): T {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return data
  }
  // Stage 1: sanitize the active span context's traceState BEFORE inject, so
  // the propagator never serializes a Sentry member. The rebuild starts from
  // context.active(), so the suppressTracing key (tick scope) is preserved and
  // inject stays a no-op under suppression.
  let injectCtx = context.active()
  const sc = trace.getSpanContext(injectCtx)
  if (sc?.traceState) {
    injectCtx = trace.setSpanContext(injectCtx, {
      ...sc,
      traceState: sanitizeTraceState(sc.traceState),
    })
  }
  const carrier: Record<string, string> = {}
  tracePropagator.inject(injectCtx, carrier, defaultTextMapSetter)
  if (Object.keys(carrier).length === 0) return data
  // Stage 2: whole-or-nothing ABNF gate on the serialized header; a header
  // that fails degrades to ABSENT (never a partially-salvaged one).
  const rawTracestate = carrier["tracestate"]
  if (rawTracestate !== undefined) {
    const validated = sanitizeTracestateHeader(rawTracestate)
    if (validated === undefined) {
      delete carrier["tracestate"]
    } else {
      carrier["tracestate"] = validated
    }
  }
  return { ...(data as Record<string, unknown>), [CARRIER_KEY]: carrier } as T
}

/**
 * Wrap a single BullMQ enqueue in a `send {queueName}` PRODUCER span and
 * inject THAT span's context as the job's creation context (messaging-semconv
 * producer modeling; the missing half of the process-side CONSUMER span).
 *
 * The `__otelctx` carrier is minted INSIDE the span callback, so the carrier's
 * span-id === the producer span's id and the worker-side CONSUMER span parents
 * to the producer (spike-verified, probe P-H). Enqueue failure ⇒ ERROR status +
 * exception event, and the error surfaces to the caller unchanged. With no
 * tracer provider registered (OTel off), the NoopTracer still runs the
 * callback — the enqueue happens, the carrier stays empty (degradation
 * spike-verified).
 *
 * Called ONLY from the queues.ts `.add` Proxy trap for non-repeatable adds —
 * a repeatable/cron template registration is a scheduler write, not a message
 * send, and stays untraced. The `queue_enqueue_bypass` guard rule
 * (scripts/guard-trace-propagation.mjs) keeps this the sole enqueue path.
 */
export function sendWithProducerSpan<R>(
  queueName: string,
  jobName: string,
  data: unknown,
  add: (dataWithCarrier: unknown) => Promise<R>
): Promise<R> {
  return tracer.startActiveSpan(
    `send ${queueName}`,
    {
      kind: SpanKind.PRODUCER,
      attributes: {
        [ATTR_MESSAGING_SYSTEM]: "bullmq",
        [ATTR_MESSAGING_OPERATION_TYPE]: MESSAGING_OPERATION_TYPE_VALUE_SEND,
        [ATTR_MESSAGING_OPERATION_NAME]: "send",
        [ATTR_MESSAGING_DESTINATION_NAME]: queueName,
        // House attribute (messaging.bullmq.* namespace, like the consumer's
        // wait_time_ms): the BullMQ job name within the queue.
        "messaging.bullmq.job.name": jobName,
      },
    },
    async (span) => {
      try {
        const job = await add(injectTraceContext(data))
        const jobId = (job as { id?: unknown } | null | undefined)?.id
        if (typeof jobId === "string" && jobId !== "") {
          span.setAttribute(ATTR_MESSAGING_MESSAGE_ID, jobId)
        }
        span.end()
        return job
      } catch (err) {
        span.recordException(err as Error)
        span.setStatus({ code: SpanStatusCode.ERROR })
        span.end()
        throw err
      }
    }
  )
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
 *
 * Under the producer-span model (sendWithProducerSpan, called by the queues.ts
 * `.add` trap), a rooted enqueue is NOT span-less end to end: the trap still
 * opens a `send {q}` PRODUCER span — but against ROOT_CONTEXT it is a fresh
 * PARENTLESS root, so the carrier is non-empty (the consumer parents to that
 * producer root) while cross-attribution stays prevented: the requeued turn's
 * trace shares nothing with the enqueuing job's trace.
 *
 * Load-bearing side effect (unit-pinned in job-tracing.test.ts): switching to
 * ROOT_CONTEXT also DROPS the `suppressTracing` context key, so this is the
 * sanctioned escape hatch out of `tracedTickWorker`'s suppressed tick scope —
 * a work-path enqueue wrapped in `withRootTrace` records spans and injects
 * carriers again, becoming its own fresh trace root.
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
 * `linkKind` stamps `synapse.link.kind` on every link — default
 * `"session_wakeup"` for the fan-in turn; remote-agent delivery failure spans
 * pass `"remote_agent_delivery"` ([adj 19]).
 *
 * Unsampled upstreams (flags-00) are SKIPPED, counted in the active span's
 * `synapse.wakeup.links_skipped_unsampled` attribute: the head-sampled
 * Alloy→Tempo backend never stores unsampled traces, so such links could never
 * resolve — and `isSpanContextValid` deliberately does NOT filter them (an
 * explicit sampled-bit check is required; spike-verified, probe P-H).
 *
 * Links are added POST-creation (`span.addLink`) by design: the drained rows
 * are only knowable inside the job, after the CONSUMER span exists. This is
 * spec-sanctioned; "post-creation links are invisible to head samplers" is
 * moot here — neither configured sampler (OTel-owned ratio root sampler,
 * Sentry forward-rate) is link-aware. Revisit ONLY if a link-aware sampler is
 * ever introduced. The SDK's default `linkCountLimit` is 128 — per-session
 * wakeup fan-in is far below it.
 *
 * No-op when OTel is off / there is no active span / a traceparent is malformed.
 * A self-link is skipped — the idle→enqueue path legitimately continues its own
 * request trace as the parent, so linking it to itself would be noise (and it
 * makes C's single-origin parented delivery case double-count nothing).
 */
export function linkUpstreamTraces(
  traceparents: Iterable<string>,
  linkKind: string = "session_wakeup"
): void {
  const span = trace.getActiveSpan()
  if (!span) return
  const ownTraceId = span.spanContext().traceId
  let skippedUnsampled = 0
  for (const tp of traceparents) {
    if (!tp) continue
    const ctx = tracePropagator.extract(
      ROOT_CONTEXT,
      { traceparent: tp },
      defaultTextMapGetter
    )
    const sc = trace.getSpanContext(ctx)
    if (!sc || !isSpanContextValid(sc) || sc.traceId === ownTraceId) continue
    if ((sc.traceFlags & TraceFlags.SAMPLED) === 0) {
      skippedUnsampled += 1
      continue
    }
    span.addLink({
      context: sc,
      attributes: { "synapse.link.kind": linkKind },
    })
  }
  if (skippedUnsampled > 0) {
    span.setAttribute(
      "synapse.wakeup.links_skipped_unsampled",
      skippedUnsampled
    )
  }
}

type AnyJob = Job<unknown, unknown, string>

/**
 * Wrap a BullMQ processor so each job runs inside a `process {queueName}`
 * CONSUMER span that continues the trace captured at enqueue time (or starts a
 * fresh trace if none). Worker logs emitted within then carry the right
 * trace_id via the logger mixin.
 *
 * The carrier is minted inside the `send {queueName}` PRODUCER span
 * (sendWithProducerSpan), so this span parents DIRECTLY to the producer —
 * the semconv single-message exception to the link-based batch modeling.
 *
 * `messaging.bullmq.job.wait_time_ms` is queue dwell: bullmq 5.78.0 populates
 * `job.processedOn` BEFORE the processor runs (source-verified), and
 * subtracting `job.delay` keeps intentionally-delayed jobs from reading as
 * queue backlog; `messaging.bullmq.job.attempts_made` disambiguates
 * backoff-inflated dwell on retried jobs.
 *
 * Exported only as the unit-test seam (exercising it needs no Redis-backed
 * Worker — job-tracing.test.ts drives it with a stub Job). Production code
 * uses `tracedWorker`.
 */
/**
 * A shallow copy of an inbound `__otelctx` carrier with its `tracestate` run
 * through the canonical gate: a grammar-invalid / duplicate-keyed / over-512
 * value is DROPPED (the key removed) so only a gate-clean tracestate reaches
 * `extractTraceCarrierContext`. The traceparent is untouched.
 */
function gateInboundCarrier(
  carrier: Record<string, string>
): Record<string, string> {
  const gated: Record<string, string> = { ...carrier }
  const ts = carrier["tracestate"]
  if (typeof ts === "string") {
    const clean = sanitizeTracestateHeader(ts)
    if (clean === undefined) delete gated["tracestate"]
    else gated["tracestate"] = clean
  }
  return gated
}

export function withJobSpan(
  queueName: string,
  processor: Processor<unknown, unknown, string>
): Processor<unknown, unknown, string> {
  return (job: AnyJob, token?: string) => {
    const data = job.data
    const carrier =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)[CARRIER_KEY]
        : undefined
    // Gate the inbound `__otelctx` tracestate (previously zero validation) and
    // route the extract through stage 3 so a Level-2-only key the transport
    // salvages drops the tracestate whole, never partially. The traceparent —
    // and the producer trace continuation — always survive.
    const parent =
      carrier && typeof carrier === "object"
        ? extractTraceCarrierContext(
            context.active(),
            gateInboundCarrier(carrier as Record<string, string>),
            tracePropagator
          )
        : context.active()

    return context.with(parent, () =>
      tracer.startActiveSpan(
        `process ${queueName}`,
        {
          kind: SpanKind.CONSUMER,
          attributes: {
            [ATTR_MESSAGING_SYSTEM]: "bullmq",
            [ATTR_MESSAGING_OPERATION_TYPE]:
              MESSAGING_OPERATION_TYPE_VALUE_PROCESS,
            [ATTR_MESSAGING_OPERATION_NAME]: "process",
            [ATTR_MESSAGING_DESTINATION_NAME]: queueName,
            [ATTR_MESSAGING_MESSAGE_ID]: job.id ?? "",
            "messaging.bullmq.job.wait_time_ms": Math.max(
              0,
              // datetime-ok: plan-prescribed queue-dwell METRIC formula (trace
              // plan §4.H) — bullmq 5.78.0 populates processedOn before the
              // processor runs, so Date.now() is a deliberate now-default for
              // the never-expected missing case in a span attribute, not a
              // value-masking timestamp fallback.
              (job.processedOn ?? Date.now()) - job.timestamp - (job.delay ?? 0)
            ),
            "messaging.bullmq.job.attempts_made": job.attemptsMade,
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
 * job (see withJobSpan). Use this instead of `new Worker` for payload-carrying
 * Synapse workers so worker logs/spans correlate with the enqueueing request;
 * high-frequency repeatable tick workers (schedulers/sweepers) use
 * `tracedTickWorker` instead — see the P-TICK policy below. Generics
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

/**
 * How a tick worker signals "this tick found work" (and optionally how much) to
 * `tracedTickWorker`, evaluated against the processor's return value.
 */
export type TickTraceOptions<ResultType> = {
  /** True iff the tick found/scheduled work — emits the backdated summary span. */
  hasWork: (result: ResultType) => boolean
  /** Item count for the summary span's `synapse.tick.items` attribute. */
  workCount?: (result: ResultType) => number
}

/**
 * Processor wrapper behind `tracedTickWorker` — exported only as the unit-test
 * seam (exercising it needs no Redis-backed Worker). Production code uses
 * `tracedTickWorker`.
 */
export function wrapTickProcessor<
  DataType,
  ResultType,
  NameType extends string,
>(
  name: string,
  processor: Processor<DataType, ResultType, NameType>,
  tick: TickTraceOptions<ResultType>
): Processor<DataType, ResultType, NameType> {
  return async (job, token) => {
    const startTime = Date.now()
    // Created against ROOT_CONTEXT explicitly: (a) outside the suppressed scope
    // below, so it records; (b) parentless by construction — repeatable tick
    // templates are never trace-injected (see queues.ts), so there is no
    // upstream trace to continue.
    const emitSummarySpan = (configure: (span: Span) => void) => {
      const span = tracer.startSpan(
        `process ${name}`,
        {
          kind: SpanKind.CONSUMER,
          startTime,
          attributes: {
            [ATTR_MESSAGING_SYSTEM]: "bullmq",
            [ATTR_MESSAGING_DESTINATION_NAME]: name,
          },
        },
        ROOT_CONTEXT
      )
      configure(span)
      span.end()
    }
    try {
      const result = await context.with(suppressTracing(ROOT_CONTEXT), () =>
        processor(job, token)
      )
      if (tick.hasWork(result)) {
        emitSummarySpan((span) => {
          if (tick.workCount) {
            span.setAttribute("synapse.tick.items", tick.workCount(result))
          }
        })
      }
      return result
    } catch (err) {
      // Error ticks DO emit the summary span — failures are signal, not noise.
      emitSummarySpan((span) => {
        span.recordException(err as Error)
        span.setStatus({ code: SpanStatusCode.ERROR })
      })
      throw err
    }
  }
}

/**
 * Tick-worker variant of `tracedWorker` for high-frequency repeatable jobs —
 * schedulers/sweepers that fire every few seconds and usually find nothing.
 *
 * A `tracedWorker` would emit one root CONSUMER span per tick; at the in-tree
 * 15s/10s cadences that is >14k orphan single-span traces per day drowning the
 * backend. Policy (P-TICK): **a no-op tick exports ZERO spans.**
 *
 * Mechanism (spike-verified against the installed @opentelemetry/core 2.8.0
 * and re-pinned in job-tracing.test.ts):
 *
 * - The processor runs under `context.with(suppressTracing(ROOT_CONTEXT), ...)`.
 *   Suppression is enforced by the SDK Tracer (spans come back non-recording)
 *   AND by propagator inject, so neither manual spans nor future
 *   auto-instrumentation (pg/ioredis/undici) can reintroduce orphan tick roots.
 * - When the tick found work (`hasWork(result)`), ONE **backdated** parentless
 *   `process {name}` CONSUMER summary span is emitted: started with the
 *   pre-processor wall-clock `startTime` and ended immediately, so its duration
 *   is the true tick duration; `synapse.tick.items` carries `workCount(result)`.
 * - The summary span does not exist while the processor runs, so it mechanically
 *   CANNOT parent the work the tick schedules ([adj 2, amended by A1]).
 *   Work-path enqueues instead escape suppression via `withRootTrace`, making
 *   each scheduled execution its own trace root. Per-item roots are deliberate:
 *   one tick schedules executions across unrelated workspaces — parenting them
 *   under the tick span would mix tenants in one trace.
 * - A throwing tick DOES emit the summary span (recordException + ERROR status)
 *   and rethrows, so BullMQ retry/failed semantics are unchanged [adj 2-A1].
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function tracedTickWorker<
  DataType = any,
  ResultType = any,
  NameType extends string = string,
>(
  name: string,
  processor: Processor<DataType, ResultType, NameType>,
  opts: WorkerOptions | undefined,
  tick: TickTraceOptions<ResultType>
): Worker<DataType, ResultType, NameType> {
  return new Worker<DataType, ResultType, NameType>(
    name,
    wrapTickProcessor(name, processor, tick),
    opts
  )
}
/* eslint-enable @typescript-eslint/no-explicit-any */
