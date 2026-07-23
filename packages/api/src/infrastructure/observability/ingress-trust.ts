// Ring-0 public-ingress trust marker + the keyed ratio sampler (round-2 trust
// boundary, docs/trace-correctness-remediation-plan-2026-07-12.md §3a amendment
// A3). The single source of truth for "did this trace context arrive through the
// public edge", and the salted sampler that stops a public caller from mining a
// trace id that passes a ratio sampler.
//
// INVARIANTS (do not weaken any of these):
//   * The marker only ever DOWNGRADES trust. Its presence adds a span attribute
//     (`synapse.trace.ingress=public`) for pricing/policy; it grants NOTHING and
//     is guard-forbidden (scripts/guard-trace-propagation.mjs `ingress_marker_misuse`)
//     from any authn/authz/rate-limit/exemption code.
//   * It is never echoed to a client, never added to CORS exposedHeaders, never
//     injected on egress — PublicIngressPropagator.inject delegates verbatim.
//   * ABSENCE means "did not traverse the public edge", which is only reachable
//     from inside the box: compose publishes the api on 127.0.0.1:3001 only. If
//     the api's HTTP port is ever published on a public interface, absence stops
//     meaning internal and the marker breaks (docker-compose.yml records this).
//   * R3 (adjudication-2): the marker does NOT select a different sampling math.
//     Once a ratio-class sampler is configured, ONE keyed function is the ratio
//     for the root arm AND both remote arms — the marker is attributes/policy
//     only. A per-ring sampling split would give a trace that entered via the
//     edge (keyed) then hopped internally (some other fold) contradictory
//     decisions and split it.
//
// Imports stay minimal (@opentelemetry/api, @opentelemetry/sdk-trace-base,
// node:crypto) so instrumentation.ts — the app's very first import — can pull
// this in with no heavy transitive load.
import {
  createContextKey,
  isSpanContextValid,
  isValidTraceId,
  trace,
  type Attributes,
  type Context,
  type Link,
  type SpanKind,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
} from "@opentelemetry/api"
import {
  SamplingDecision,
  type Sampler,
  type SamplingResult,
} from "@opentelemetry/sdk-trace-base"
import { createHmac, randomBytes } from "node:crypto"

/** The header nginx FORCES on every proxied public location (proxy_set_header
 * overrides any client copy). Node lowercases inbound header names, so the
 * default TextMapGetter finds it under this exact key. */
export const PUBLIC_INGRESS_HEADER = "x-synapse-trace-ingress"
/** The only value nginx sets. Presence — not this exact value — is what marks
 * untrusted ingress; matching the value strictly would fail OPEN on an
 * unexpected value, so we never do. */
export const PUBLIC_INGRESS_VALUE = "public"
/** Span attribute stamped on public-edge entry spans (mirrors Datadog's
 * `o:rum` origin marker) — the operator's Tempo/Grafana handle for pricing or
 * dropping public traffic without a code change. */
export const ATTR_TRACE_INGRESS = "synapse.trace.ingress"

// One OTel context key, two setters (the HTTP propagator + the WS envelope
// helper), one predicate. Module-private so nothing can read/write it except
// through markPublicIngress / isPublicIngress.
const PUBLIC_INGRESS_KEY = createContextKey("synapse.trace.public-ingress")

/** Tag a context as having arrived through the public edge (Ring 0). */
export function markPublicIngress(ctx: Context): Context {
  return ctx.setValue(PUBLIC_INGRESS_KEY, true)
}

/** True iff this context was extracted from a public-edge carrier. */
export function isPublicIngress(ctx: Context): boolean {
  return ctx.getValue(PUBLIC_INGRESS_KEY) === true
}

/**
 * Wraps the outermost propagator. `extract` delegates, then marks the resulting
 * context iff the carrier carried the nginx-forced ingress header — covering ALL
 * HTTP ingress with no per-route work. `inject`/`fields` delegate verbatim: this
 * wrapper NEVER writes the marker onto any wire (it is a receive-side signal
 * only).
 */
export class PublicIngressPropagator implements TextMapPropagator {
  constructor(private readonly inner: TextMapPropagator) {}

  inject(context: Context, carrier: unknown, setter: TextMapSetter): void {
    this.inner.inject(context, carrier, setter)
  }

  extract(context: Context, carrier: unknown, getter: TextMapGetter): Context {
    const extracted = this.inner.extract(context, carrier, getter)
    return getter.get(carrier, PUBLIC_INGRESS_HEADER) !== undefined
      ? markPublicIngress(extracted)
      : extracted
  }

  fields(): string[] {
    return this.inner.fields()
  }
}

/** Normalize a ratio exactly as @opentelemetry/sdk-trace-base's
 * TraceIdRatioBasedSampler does: non-number/NaN → 0, clamp to [0,1]. */
function normalizeRatio(ratio: number): number {
  if (typeof ratio !== "number" || Number.isNaN(ratio)) return 0
  if (ratio >= 1) return 1
  if (ratio <= 0) return 0
  return ratio
}

/**
 * A ratio sampler whose accumulator is `HMAC-SHA256(salt, traceId)[0..4)` big-
 * endian, compared against `floor(ratio * 0xffffffff)` — INSTEAD of the SDK's
 * public XOR fold of the trace id's four 32-bit words (F6: that fold makes a
 * structured id such as `deadbeefdeadbeefcafebabecafebabe` sampled at every
 * nonzero ratio in O(1), so a public caller can pick an always-recorded id).
 *
 * Still DETERMINISTIC per trace id, which is load-bearing: a Sentry pageload
 * transaction issues many fetches under ONE trace id, so all N get the same
 * answer (a per-request random draw would fragment a legitimate browser trace).
 * Keyed by a per-process (or shared, for multi-replica) salt, so the mapping
 * from trace id to decision is unpredictable to a caller who does not hold the
 * salt. Boundary handling is a deliberate, documented improvement on the SDK's
 * `acc < upperBound`: ratio 1 short-circuits to RECORD (the SDK drops an id that
 * accumulates to 0xffffffff even at ratio 1), ratio 0 / invalid id → NOT_RECORD.
 * `toString()` never prints the salt.
 */
export class KeyedTraceIdRatioSampler implements Sampler {
  private readonly ratio: number
  private readonly upperBound: number

  constructor(
    ratio: number,
    private readonly salt: Buffer
  ) {
    this.ratio = normalizeRatio(ratio)
    this.upperBound = Math.floor(this.ratio * 0xffffffff)
  }

  shouldSample(_context: Context, traceId: string): SamplingResult {
    if (this.ratio >= 1) {
      return { decision: SamplingDecision.RECORD_AND_SAMPLED }
    }
    if (this.ratio <= 0 || !isValidTraceId(traceId)) {
      return { decision: SamplingDecision.NOT_RECORD }
    }
    const accumulator = createHmac("sha256", this.salt)
      .update(traceId, "ascii")
      .digest()
      .readUInt32BE(0)
    return {
      decision:
        accumulator < this.upperBound
          ? SamplingDecision.RECORD_AND_SAMPLED
          : SamplingDecision.NOT_RECORD,
    }
  }

  toString(): string {
    return `KeyedTraceIdRatioBased{${this.ratio}}`
  }
}

/**
 * Outermost sampler wrapper: stamps `synapse.trace.ingress=public` on the
 * SamplingResult for ENTRY spans that arrived through the public edge, in EVERY
 * sampler config (including the AlwaysOn default — the marker's ONLY observable
 * effect there). Never changes the decision. "Entry span" = parent span context
 * absent-or-invalid OR remote; a local-parent descendant inherits the context
 * key but is NOT tagged, so the attribute stays off every pg/redis/http child.
 */
export class IngressTaggingSampler implements Sampler {
  constructor(private readonly base: Sampler) {}

  shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[]
  ): SamplingResult {
    const result = this.base.shouldSample(
      context,
      traceId,
      spanName,
      spanKind,
      attributes,
      links
    )
    if (result.decision === SamplingDecision.NOT_RECORD) return result
    if (!isPublicIngress(context)) return result
    const parent = trace.getSpanContext(context)
    const isEntrySpan =
      parent === undefined ||
      !isSpanContextValid(parent) ||
      parent.isRemote === true
    if (!isEntrySpan) return result
    return {
      ...result,
      attributes: {
        ...result.attributes,
        [ATTR_TRACE_INGRESS]: PUBLIC_INGRESS_VALUE,
      },
    }
  }

  toString(): string {
    return `IngressTagging(${this.base.toString()})`
  }
}

/**
 * Salt for the keyed sampler: `SYNAPSE_TRACE_SAMPLING_SALT` (UTF-8 bytes) when
 * non-empty, else 16 random bytes minted per process. Resolved LAZILY — only the
 * ratio-class branches of buildSamplerFromEnvVars call this, so a default
 * (AlwaysOn) deployment never mints one. A shared salt is required only when
 * more than one api replica serves the same public origin (a browser trace can
 * then land on different replicas and must get the same answer). Never logged.
 */
export function resolveSamplingSalt(): Buffer {
  const raw = process.env.SYNAPSE_TRACE_SAMPLING_SALT
  if (raw !== undefined && raw !== "") return Buffer.from(raw, "utf8")
  return randomBytes(16)
}
