/**
 * OpenTelemetry tracing bootstrap (+ optional Sentry error capture).
 *
 * Imported as the VERY FIRST import of src/index.ts so the HTTP instrumentation
 * patches node:http before the Fastify server / outbound HTTP clients are
 * created. (Log↔trace correlation does NOT rely on module patching; it is read
 * live from the active span via the pino `mixin` in infrastructure/logger.)
 *
 * ARCHITECTURE (docs/trace-correctness-remediation-plan-2026-07-12.md §3a/§3b/§4.A):
 * the OTel SDK owns sampling, instrumentation, and export in BOTH configs
 * (Sentry on and off). Sentry is an error-capture client plus an OPTIONAL span
 * consumer behind a deterministic forward rate — it never changes the
 * instrumentation set, the sampler, or OTLP volume. Never re-enable Sentry's
 * auto-performance integrations (see the Sentry.init comment below).
 *
 * Environment variables honored here (identically in both configs):
 *   OTEL_EXPORTER_OTLP_ENDPOINT          base OTLP/HTTP endpoint (e.g. http://alloy:4318);
 *                                        traces POST to <endpoint>/v1/traces.
 *   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT   per-signal override, used as-is; either
 *                                        endpoint var enables export.
 *   OTEL_SERVICE_NAME                    service.name resource attribute
 *                                        (default "synapse-api").
 *   OTEL_TRACES_SAMPLER(_ARG)            THE OTLP volume knob — the six spec values,
 *                                        mapped by buildSamplerFromEnvVars() below.
 *   OTEL_SDK_DISABLED                    true = no-op tracing; the api still boots
 *                                        and serves; Sentry error capture survives.
 *   OTEL_LOG_LEVEL                       SDK self-diagnostics level (default ERROR).
 *   OTEL_RESOURCE_ATTRIBUTES             honored via envDetector.
 *   OTEL_SEMCONV_STABILITY_OPT_IN        code-defaulted to "http" (stable-only HTTP
 *                                        semconv names, matching undici/@fastify/otel).
 *   SENTRY_DSN                           enables Sentry error capture. Empty = off.
 *                                        Never changes OTLP volume or instrumentation.
 *   SENTRY_ENVIRONMENT                   Sentry environment (default NODE_ENV).
 *   SENTRY_TRACES_SAMPLE_RATE            the Sentry FORWARD rate ([D4]): fraction of
 *                                        traces forwarded to Sentry Performance —
 *                                        event-level, deterministic per trace-id, applied
 *                                        in beforeSendTransaction. DEFAULT 0 = errors-only
 *                                        (no SentrySpanProcessor). NOT a head-sampling
 *                                        rate; OTLP/Tempo volume is never affected.
 *                                        Consumed here and then REMOVED from process.env
 *                                        (the Sentry SDK's env fallback would otherwise
 *                                        re-read the repurposed value as a head rate).
 *                                        Set-but-invalid values log at diag ERROR.
 *   SYNAPSE_TRACE_FIRST_PARTY_HOSTS      extra first-party hosts for egress header
 *                                        propagation (first-party-propagator.ts).
 *
 * If neither OTLP nor Sentry is configured, spans are still created (so logs
 * carry trace_id) but nothing is exported — a safe no-backend default.
 *
 * DOCUMENTED DEVIATIONS from the OTel env spec:
 *   - OTEL_PROPAGATORS is not honored (sdk-trace-node 2.x removed it; our
 *     propagator is policy, not configuration — see docs/trace-propagation-policy.md).
 *   - diag default level is ERROR, not the spec's `info` (exporter failures log;
 *     healthy operation stays silent). Override via OTEL_LOG_LEVEL.
 *   - Hardened remote-parent sampler arms (§3a, adjudication 1 + amendment A2):
 *     inbound remote flags are ADVISORY — operator intent wins in both directions.
 *
 *       OTEL_TRACES_SAMPLER        | root        | remoteParentSampled | remoteParentNotSampled
 *       ---------------------------|-------------|---------------------|-----------------------
 *       unset (default)            | AlwaysOn    | AlwaysOn            | AlwaysOn
 *       parentbased_always_on      | AlwaysOn    | AlwaysOn            | AlwaysOn
 *       parentbased_traceidratio   | ratio(ARG)  | same ratio instance | same ratio instance
 *       parentbased_always_off     | AlwaysOff   | AlwaysOff           | AlwaysOff
 *       always_on/always_off/traceidratio — as specced, no ParentBased wrapper.
 *
 *     The spec's default ParentBased arms (AlwaysOn/AlwaysOff) would let a forged
 *     one-line `…-00`/`…-01` header erase or force backend recording; binding both
 *     arms bounds forged flags by the operator's own rate. The bound is
 *     volume-economic, not absolute (trace-id mining residual, §3a).
 *
 * LOAD-BEARING MECHANISM (not residue — do not "clean up"): the forced CJS
 * requires at the bottom of the provider block (`cjsRequire("http"/"https"/
 * "pg"/"ioredis")`) are what ACTIVATE those instrumentations for this ESM app.
 * registerInstrumentations patches via require-in-the-middle only; a plain ESM
 * `import pg from "pg"` (or `node:http`) bypasses it on Node 22 — no
 * import-in-the-middle loader is registered. Pinned by probe P-A5 (pg/ioredis)
 * and the boot-matrix node:http traceparent check.
 *
 * LAYER RESPONSIBILITIES (§3a — neither layer claims the other's job):
 *   - this sampler = FORCE and ERASE bounds on inbound flags (volume-economic);
 *   - nginx (Ring 0) = vendor-state hygiene + tracestate/baggage trust boundary.
 *
 * W3C baggage is deliberately NOT propagated (adjudication 6): the Sentry-off
 * propagator is W3CTraceContextPropagator only — no W3CBaggagePropagator — until
 * a real producer exists. Re-adoption convention: docs/trace-propagation-policy.md.
 * (Sentry-on retains Sentry DSC as `baggage` on first-party hops by design,
 * gated off third parties by FirstPartyOnlyPropagator.)
 */
import "./infrastructure/env-bootstrap.js"

import {
  context as otelContext,
  diag,
  trace,
  DiagConsoleLogger,
  DiagLogLevel,
  type Attributes,
  type Context,
  type Link,
  type SpanKind,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
} from "@opentelemetry/api"
import {
  CompositePropagator,
  W3CTraceContextPropagator,
  diagLogLevelFromString,
  getBooleanFromEnv,
  getStringFromEnv,
} from "@opentelemetry/core"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { registerInstrumentations } from "@opentelemetry/instrumentation"
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http"
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis"
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg"
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici"
import {
  defaultResource,
  detectResources,
  envDetector,
  hostDetector,
  processDetector,
  resourceFromAttributes,
} from "@opentelemetry/resources"
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type Sampler,
  type SamplingResult,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions"
import { FastifyOtelInstrumentation } from "@fastify/otel"
import * as Sentry from "@sentry/node"
import {
  SentryPropagator,
  SentrySpanProcessor,
  wrapSamplingDecision,
} from "@sentry/opentelemetry"
import { createRequire } from "node:module"
import type { FastifyInstance } from "fastify"
import { firstPartyPropagator } from "./infrastructure/observability/first-party-propagator.js"
import { isExpectedClientError } from "./infrastructure/observability/request-error-classification.js"
import { sanitizeTraceState } from "./infrastructure/observability/traceparent.js"

// Stable-only HTTP semconv names (http.request.method / http.response.status_code
// / url.path) so instrumentation-http matches undici + @fastify/otel. MUST be set
// before HttpInstrumentation is CONSTRUCTED — it reads this env in its
// constructor. Operators may override to "http/dup" for migration debugging.
// (`||=`, not `??=`: the OTel env spec treats empty-string vars as unset, and
// compose-style `${VAR:-}` passthroughs materialize exactly that empty string.)
process.env.OTEL_SEMCONV_STABILITY_OPT_IN ||= "http"

// OTEL_SDK_DISABLED short-circuits the provider + instrumentations below (spec
// compliance). Sentry error capture is independent of it.
const otelDisabled = getBooleanFromEnv("OTEL_SDK_DISABLED") ?? false

// SDK self-diagnostics, ALWAYS registered: exporter failures were previously
// completely silent. Default ERROR (documented deviation from the spec's info).
diag.setLogger(new DiagConsoleLogger(), {
  logLevel: (() => {
    const raw = getStringFromEnv("OTEL_LOG_LEVEL")
    return raw ? diagLogLevelFromString(raw) : DiagLogLevel.ERROR
  })(),
})

const serviceName = getStringFromEnv("OTEL_SERVICE_NAME") ?? "synapse-api"

// defaultResource + env/process/host detectors (OTEL_RESOURCE_ATTRIBUTES is now
// honored) + explicit attributes merged last so they win.
const resource = defaultResource()
  .merge(
    detectResources({ detectors: [envDetector, processDetector, hostDetector] })
  )
  .merge(
    resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      "service.namespace": "synapse",
    })
  )

// Settle the detectors' async attributes (host.id lookup etc.) as early as
// possible: consumers that read resource.attributes before settlement (e.g.
// Sentry's span processor on a very early span) trigger a diag error and see
// a partial resource. Fire-and-forget — nothing at import time may block — so
// this is BEST-EFFORT only: a span created before the promise settles can
// still trip the SDK's "accessing resource attributes before async attributes
// settled" diag line (harmless; the exporter re-reads settled attributes).
void resource.waitForAsyncAttributes?.().catch(() => {})

// Export gate: either endpoint variable enables export (the per-signal
// _TRACES_ENDPOINT variant was previously ignored). The exporter itself is
// constructed with no args so it reads the env per the OTLP exporter spec.
const otlpConfigured =
  getStringFromEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") ??
  getStringFromEnv("OTEL_EXPORTER_OTLP_ENDPOINT")

// ---------------------------------------------------------------------------
// Sampling (§3a). buildSamplerFromEnvVars maps the six OTEL_TRACES_SAMPLER spec
// values — installed @opentelemetry/sdk-trace-base 2.8.0 does not export its
// own env→sampler builder. Remote-parent arms are hardened per the file-header
// table. Unparsable / out-of-range OTEL_TRACES_SAMPLER_ARG → diag.warn +
// treated as unset (1.0) — the env spec's "MUST be otherwise ignored"; no
// clamping (clamping -0.2 to 0 would invert the ignore semantics).
// NB: the two house diag.warn misconfig messages below are invisible at the
// shipped default diag level (ERROR); operator visibility is delegated to the
// installed SDK's own parallel env evaluation, which reports ratio-ARG /
// unknown-sampler-name misconfig at ERROR with the same fallback outcome.
// Raise OTEL_LOG_LEVEL to warn to see the house messages too.
// ---------------------------------------------------------------------------

function parseSamplerRatioArg(): number {
  const raw = getStringFromEnv("OTEL_TRACES_SAMPLER_ARG")
  if (raw === undefined) return 1.0
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    diag.warn(
      `OTEL_TRACES_SAMPLER_ARG "${raw}" is not a number in [0,1] — ignored (ratio 1.0)`
    )
    return 1.0
  }
  return value
}

/** Default (env unset): AlwaysOn root AND both remote arms — inbound flags are
 * advisory, so a browser/attacker `sampled=00` can never erase backend
 * recording and a forged `01` is bounded by what root allows anyway. */
function defaultParentBasedAlwaysOn(): Sampler {
  const alwaysOn = new AlwaysOnSampler()
  return new ParentBasedSampler({
    root: alwaysOn,
    remoteParentSampled: alwaysOn,
    remoteParentNotSampled: alwaysOn,
  })
}

/** Env-driven sampler for the provider, read from process.env at call time. */
export function buildSamplerFromEnvVars(): Sampler {
  const name = getStringFromEnv("OTEL_TRACES_SAMPLER")
  switch (name) {
    case undefined:
    case "parentbased_always_on":
      return defaultParentBasedAlwaysOn()
    case "always_on":
      return new AlwaysOnSampler()
    case "always_off":
      return new AlwaysOffSampler()
    case "traceidratio":
      // No ParentBased wrapper — the SDK spec requires traceidratio to ignore
      // the parent flag.
      return new TraceIdRatioBasedSampler(parseSamplerRatioArg())
    case "parentbased_always_off": {
      const alwaysOff = new AlwaysOffSampler()
      return new ParentBasedSampler({
        root: alwaysOff,
        remoteParentSampled: alwaysOff,
        remoteParentNotSampled: alwaysOff,
      })
    }
    case "parentbased_traceidratio": {
      // BOTH remote arms share the SAME ratio instance: forged 01 and
      // forged/honest 00 flags are equally bounded by the operator's ratio,
      // and per-trace-id determinism keeps first-party traces whole. (Local
      // arms keep the SDK's parent-respecting defaults — local parents ARE
      // this process's own ratio decisions.)
      const ratio = new TraceIdRatioBasedSampler(parseSamplerRatioArg())
      return new ParentBasedSampler({
        root: ratio,
        remoteParentSampled: ratio,
        remoteParentNotSampled: ratio,
      })
    }
    default:
      diag.warn(
        `OTEL_TRACES_SAMPLER "${name}" is not a known spec value — using the default (parent-based always-on with hardened remote arms)`
      )
      return defaultParentBasedAlwaysOn()
  }
}

/**
 * Under Sentry, WRAP the Synapse sampler — never replace it with SentrySampler
 * (which drops 100% of parentless CLIENT spans from OTLP). wrapSamplingDecision
 * keeps Sentry DSC/traceState continuity on the decision. Accepted delta vs
 * stock SentrySampler: sampleRand/downstreamTraceSampleRate are omitted, so
 * locally-rooted traces carry DSC without sample_rand/sample_rate members —
 * harmless, because Sentry forwarding is decided event-level in
 * beforeSendTransaction (§3a).
 */
class SentryWrappedSampler implements Sampler {
  constructor(private readonly base: Sampler) {}

  shouldSample(
    samplingContext: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[]
  ): SamplingResult {
    const { decision } = this.base.shouldSample(
      samplingContext,
      traceId,
      spanName,
      spanKind,
      attributes,
      links
    )
    return wrapSamplingDecision({
      decision,
      context: samplingContext,
      spanAttributes: attributes,
    })
  }

  toString(): string {
    return `SentryWrapped(${this.base.toString()})`
  }
}

// ---------------------------------------------------------------------------
// Sentry (optional, gated on SENTRY_DSN) — error-capture client + optional span
// consumer. skipOpenTelemetrySetup: we own the provider below.
// ---------------------------------------------------------------------------

const sentryDsn = process.env.SENTRY_DSN

// SENTRY_TRACES_SAMPLE_RATE is the Sentry FORWARD rate ([D4] — default 0 =
// errors-only, matching Sentry's own DSN-without-tracesSampleRate semantics).
// It gates the SentrySpanProcessor + a deterministic per-trace-id event drop;
// it never touches OTLP volume.
const sentryForwardRate = (() => {
  const raw = process.env.SENTRY_TRACES_SAMPLE_RATE
  const value = Number(raw ?? "0")
  if (
    raw !== undefined &&
    raw !== "" && // empty string = unset (compose `${VAR:-}` passthrough)
    (!Number.isFinite(value) || value < 0 || value > 1)
  ) {
    // diag.error, not warn: this must be visible at the shipped default diag
    // level (ERROR), and unlike the OTEL_TRACES_SAMPLER warns above there is
    // no SDK-side parallel evaluation to surface it. Behavior is unchanged:
    // unparsable/negative falls back to 0 (errors-only); > 1 forwards all.
    diag.error(
      `SENTRY_TRACES_SAMPLE_RATE "${raw}" is not a number in [0,1] — ` +
        `unparsable/negative values behave as 0 (errors-only), values > 1 forward everything`
    )
  }
  return Number.isFinite(value) && value > 0 ? value : 0
})()

// The var is REPURPOSED (api forward rate, [D4]) and must never reach the
// Sentry SDK as a head-sampling rate: installed @sentry/node-core falls back
// to process.env.SENTRY_TRACES_SAMPLE_RATE whenever options.tracesSampleRate
// is undefined — exactly the rate-0 path below, where we deliberately pass no
// tracesSampleRate. Compose always materializes the var (`${VAR:-0}`), so
// without this every default deployment would boot in Sentry's
// "tracing-configured-at-rate-0" state instead of the DSN-only state [D4]
// specifies (wire-visible as a spurious sentry-sampled=true DSC baggage
// member). Passing `tracesSampleRate: undefined` does NOT help — the SDK env
// fallback fires on undefined — so unset it before Sentry.init. (Pinned by
// boot matrix 4: client.getOptions().tracesSampleRate === undefined at rate 0.)
delete process.env.SENTRY_TRACES_SAMPLE_RATE

// Sentry default integrations dropped in favor of Synapse-owned equivalents:
//   Http / NodeFetch        re-added below with spans + tracePropagation OFF, so
//                           our composite propagator is the SINGLE header writer
//                           (Sentry's writers duplicated sentry-trace with a
//                           second span id) and no Sentry http spans double-count.
//   OnUncaughtException /   replaced by the fatalExit process handlers at the
//   OnUnhandledRejection    bottom of this file — uniform strict crash semantics
//                           in both configs (Sentry's default silently flips
//                           unhandledRejection to warn-and-continue).
const droppedSentryDefaults = new Set([
  "Http",
  "NodeFetch",
  "OnUncaughtException",
  "OnUnhandledRejection",
])

const sentryClient = sentryDsn
  ? Sentry.init({
      dsn: sentryDsn,
      environment:
        process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
      // Function form (the C1 boot-crash fix): filter the auto-performance
      // integrations OUT OF THE DEFAULTS by name — they register competing
      // instrumentations (Sentry's vendored Fastify fork double-registers the
      // request decorator against @fastify/otel → FST_ERR_DEC_ALREADY_PRESENT,
      // and its unconditional-ERROR onError sits outside our @fastify/otel
      // patch's reach). NEVER re-enable them; deriving the filter set from
      // getAutoPerformanceIntegrations() survives Sentry upgrades.
      integrations: (defaults) => {
        const autoPerfNames = new Set(
          Sentry.getAutoPerformanceIntegrations().map((i) => i.name)
        )
        return [
          ...defaults.filter(
            (i) =>
              !autoPerfNames.has(i.name) && !droppedSentryDefaults.has(i.name)
          ),
          Sentry.httpIntegration({ spans: false, tracePropagation: false }),
          Sentry.nativeNodeFetchIntegration({
            spans: false,
            tracePropagation: false,
          }),
        ]
      },
      // Forward rate > 0 ⇒ Sentry sees every span (tracesSampleRate 1.0 keeps
      // DSC/transaction assembly intact) and the deterministic per-trace-id
      // drop happens EVENT-level, so the kept subset is whole-trace consistent
      // and OTLP volume is untouched. Rate 0 (default) ⇒ no tracesSampleRate,
      // no SentrySpanProcessor: errors-only.
      ...(sentryForwardRate > 0
        ? {
            tracesSampleRate: 1.0,
            beforeSendTransaction: <
              E extends { contexts?: { trace?: { trace_id?: string } } },
            >(
              event: E
            ): E | null => {
              const traceId = event.contexts?.trace?.trace_id
              if (typeof traceId !== "string" || traceId.length < 8) {
                return event // missing trace_id ⇒ keep
              }
              return parseInt(traceId.slice(0, 8), 16) / 0xffffffff <
                sentryForwardRate
                ? event
                : null
            },
          }
        : {}),
      // We own the OTel setup; do not let Sentry auto-configure it or register
      // ESM loader hooks.
      skipOpenTelemetrySetup: true,
      registerEsmLoaderHooks: false,
    })
  : undefined

// ---------------------------------------------------------------------------
// Propagator (§3b). One basePropagator, then ONE egress choke point:
// FirstPartyOnlyPropagator wraps the ENTIRE composite in both configs, so
// third-party hosts receive nothing — traceparent, tracestate, sentry-trace,
// or Sentry DSC baggage (Sentry.init tracePropagationTargets stays unset by
// design: one matcher, one policy).
// ---------------------------------------------------------------------------

/**
 * [D1] Sanitized W3C composite member: `inject` rebuilds the context with
 * `sanitizeTraceState` applied to the active span context's traceState before
 * delegating, so Sentry's grammar-invalid `sentry.*` tracestate members
 * (W3C trace-context §3.3.2: keys with `.`; values embedding `=`/`,`) never
 * serialize onto any first-party HTTP wire, while legitimate vendor members
 * pass verbatim. `extract`/`fields` delegate unchanged.
 */
function sanitizedW3CPropagator(): TextMapPropagator {
  const w3c = new W3CTraceContextPropagator()
  return {
    inject(ctx: Context, carrier: unknown, setter: TextMapSetter): void {
      const spanContext = trace.getSpanContext(ctx)
      w3c.inject(
        spanContext
          ? trace.setSpanContext(ctx, {
              ...spanContext,
              traceState: sanitizeTraceState(spanContext.traceState),
            })
          : ctx,
        carrier,
        setter
      )
    },
    extract: (ctx: Context, carrier: unknown, getter: TextMapGetter) =>
      w3c.extract(ctx, carrier, getter),
    fields: () => w3c.fields(),
  }
}

// Ordering: SentryPropagator MUST remain the member that sees the ORIGINAL
// context — it reads sentry.dsc from traceState at inject — so sanitization
// happens at the MEMBER level, never before the whole composite (a
// pre-composite filter would break first-party Sentry baggage injection).
// Sentry-off: W3CTraceContextPropagator ONLY — no W3CBaggagePropagator
// (adjudication 6; see the file header).
const basePropagator: TextMapPropagator = sentryClient
  ? new CompositePropagator({
      propagators: [new SentryPropagator(), sanitizedW3CPropagator()],
    })
  : new W3CTraceContextPropagator()

// ---------------------------------------------------------------------------
// Provider + the deterministic instrumentation set (identical in both configs).
// ---------------------------------------------------------------------------

/**
 * Value-safe redis db.statement serializer: the installed default serializer
 * fully serializes EVAL* args — i.e. whole BullMQ job payloads — into span
 * attributes. AUTH/HELLO carry credentials ⇒ command name only; everything
 * else keeps the command + first arg (usually the key) truncated to 128 chars.
 */
export function valueSafeRedisSerializer(
  cmdName: string,
  cmdArgs: Array<string | Buffer | number | unknown[]>
): string {
  if (/^(auth|hello)$/i.test(cmdName)) return cmdName
  if (cmdArgs.length === 0) return cmdName
  const first = String(cmdArgs[0]).slice(0, 128)
  const rest = cmdArgs.length - 1
  return rest > 0
    ? `${cmdName} ${first} [${rest} more args]`
    : `${cmdName} ${first}`
}

const spanProcessors: SpanProcessor[] = []
if (otlpConfigured) {
  // OTLP export (traces → Grafana Alloy → Tempo). No-arg exporter reads the
  // OTEL_EXPORTER_OTLP_* env per spec.
  spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter()))
}
if (sentryClient && sentryForwardRate > 0) {
  // Registered ONLY at forward rate > 0: the default (0) config path carries
  // zero span-processing overhead (errors-only).
  spanProcessors.push(new SentrySpanProcessor())
}

const baseSampler = buildSamplerFromEnvVars()

// Fastify route/handler/hook spans. Registered on the app in index.ts via
// `await app.register(fastifyOtelInstrumentation.plugin())` BEFORE routes.
// Constructed ALWAYS — plugin registration without a provider is a safe noop
// (noop tracer), so index.ts needs no OTEL_SDK_DISABLED branch. ignorePaths is
// inert at runtime while the http-layer ignore hook below suppresses the whole
// health trace; it exists only as a guard if that hook is ever removed.
const fastifyOtelInstrumentation = new FastifyOtelInstrumentation({
  ignorePaths: "/api/v1/health",
})

const provider = otelDisabled
  ? undefined
  : new NodeTracerProvider({
      resource,
      sampler: sentryClient
        ? new SentryWrappedSampler(baseSampler)
        : baseSampler,
      spanProcessors,
    })

if (provider) {
  provider.register({
    // The Ring-2 egress choke point wraps the composite (both configs).
    propagator: firstPartyPropagator(basePropagator, Boolean(sentryClient)),
    // Sentry needs its context manager for per-request isolation scopes; the
    // plain AsyncLocalStorage manager is its Sentry-off equivalent.
    contextManager: sentryClient
      ? new Sentry.SentryContextManager()
      : new AsyncLocalStorageContextManager(),
  })

  // The deterministic instrumentation set — exactly five, both configs.
  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      // Patches node:http: inbound requests start a SERVER span (continuing any
      // inbound W3C traceparent) and outbound http/https calls propagate.
      // Health checks + CORS preflights are suppressed at the SDK layer —
      // installed 0.219.0 wraps ignored requests in suppressTracing, so the
      // WHOLE trace (route/pg/redis children included) vanishes.
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) =>
          req.method === "OPTIONS" ||
          (req.url ?? "").split("?", 1)[0] === "/api/v1/health",
      }),
      // Patches undici / global fetch (node:http does NOT cover it): MCP SDK +
      // FastAPI sidecar clients + CubeSandbox control plane all ride this.
      new UndiciInstrumentation(),
      // Fastify route spans (activated via the plugin in index.ts; listed here
      // so the provider is wired through the same registration path).
      fastifyOtelInstrumentation,
      // pg + ioredis client spans. requireParentSpan keeps background polling
      // (BullMQ, sweepers) span-free — no parentless DB roots.
      new PgInstrumentation({
        requireParentSpan: true,
        ignoreConnectSpans: true,
      }),
      new IORedisInstrumentation({
        requireParentSpan: true,
        dbStatementSerializer: valueSafeRedisSerializer,
      }),
    ],
  })

  // Patch activation for an ESM app (LOAD-BEARING — see the file header):
  // registerInstrumentations patches via require-in-the-middle only, and a
  // plain ESM `import pg from "pg"` / `import http from "node:http"` bypasses
  // it on Node 22 (no import-in-the-middle loader is registered), so the
  // instrumentations above would silently never fire for the api's own ESM
  // imports. One forced CJS require of each patched package HERE runs through
  // the require hook, patches the shared module/prototypes in place, and every
  // later ESM import receives the same patched exports from the CJS module
  // cache. http/https are included deliberately: without them, node:http
  // patching (inbound SERVER spans + outbound propagation) depends on fastify
  // happening to be CJS and requiring http after this point — boot-graph luck,
  // not a contract. Pinned by probe P-A5 (pg/ioredis) and the boot-matrix
  // node:http traceparent check (instrumentation.boot.test.ts).
  const cjsRequire = createRequire(import.meta.url)
  cjsRequire("http")
  cjsRequire("https")
  cjsRequire("pg")
  cjsRequire("ioredis")
} else if (sentryClient) {
  // OTEL_SDK_DISABLED with Sentry on: no provider, no instrumentations — but
  // Sentry error capture still needs its context manager for isolation scopes.
  otelContext.setGlobalContextManager(
    new Sentry.SentryContextManager().enable()
  )
}

if (sentryClient && provider) {
  // Debug-build-only sanity logging on the Sentry↔OTel wiring.
  Sentry.validateOpenTelemetrySetup()
}

export { fastifyOtelInstrumentation }

/**
 * Sentry error reporting for Fastify route errors, gated on the SHARED
 * client-error classification (adjudication 7): expected 4xx-class errors
 * (ZodError / malformed-UUID 22P02 / statusCode 400–499) never reach Sentry.
 * A house onError hook — NOT Sentry.setupFastifyErrorHandler: with the Fastify
 * integration filtered out above, its shouldHandleError option is stored
 * nowhere reachable, and its default (statusCode ≥ 500 || ≤ 299) captures every
 * expected 400 because reply.statusCode is still 200 at onError time.
 *
 * The hook registers UNCONDITIONALLY — only the capture inside is gated on the
 * Sentry client. This keeps the fastify hook topology (and therefore
 * @fastify/otel's per-route hook spans) byte-identical with and without a DSN,
 * per invariant I1 / the §10 "SENTRY_DSN never changes OTLP volume or
 * instrumentation set" contract (pinned by probe P-A10 case B). Capture is a
 * no-op when Sentry is disabled.
 */
export function setupSentryErrorHandler(app: FastifyInstance): void {
  app.addHook("onError", async (_request, _reply, error) => {
    if (!sentryClient || isExpectedClientError(error)) return
    Sentry.captureException(error, {
      mechanism: { handled: false, type: "auto.function.fastify" },
    })
  })
}

/**
 * Flush buffered telemetry WITHOUT shutting anything down (spans via
 * provider.forceFlush, Sentry events via Sentry.flush). Used as the early
 * drain at the head of graceful shutdown — the final flush step sits behind
 * ~38s of worst-case step budgets while the in-app force-exit timer fires at
 * 15s. Best-effort: never throws.
 */
export async function flushTelemetry(): Promise<void> {
  if (provider) {
    try {
      await provider.forceFlush()
    } catch (err) {
      // Never throws — but never silent either (a dead OTLP endpoint must be
      // visible at the default ERROR diag level).
      diag.error("telemetry flush: span export failed", err)
    }
  }
  if (sentryClient) {
    try {
      await Sentry.flush(2000)
    } catch (err) {
      diag.error("telemetry flush: Sentry flush failed", err)
    }
  }
}

/**
 * Flush + shut down telemetry on graceful shutdown so buffered spans/events are
 * not lost on SIGTERM. Best-effort: never throws.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (provider) {
    try {
      await provider.forceFlush()
    } catch (err) {
      diag.error("telemetry shutdown: span export failed", err)
    }
    try {
      await provider.shutdown()
    } catch (err) {
      diag.error("telemetry shutdown: provider shutdown failed", err)
    }
  }
  if (sentryClient) {
    try {
      await Sentry.close(2000)
    } catch (err) {
      diag.error("telemetry shutdown: Sentry close failed", err)
    }
  }
}

let fatalExitStarted = false

/**
 * Terminal error path: log → capture to Sentry (tagged `fatal.context`) →
 * bounded telemetry flush (3s cap, unref'd so a hung exporter cannot block
 * exit) → process.exit. Used by the startup exits and the shutdown
 * force-exit/catch paths in index.ts, and by the process-level handlers below.
 * Reentrant calls log and park (the first call exits within ~3s).
 */
export async function fatalExit(
  err: unknown,
  fatalContext: string,
  code = 1
): Promise<never> {
  if (fatalExitStarted) {
    console.error(`[fatal] (${fatalContext}) while already exiting:`, err)
    return new Promise<never>(() => {})
  }
  fatalExitStarted = true
  console.error(`[fatal] ${fatalContext}:`, err)
  if (sentryClient) {
    Sentry.captureException(err, {
      mechanism: { handled: false, type: "generic" },
      captureContext: { tags: { "fatal.context": fatalContext } },
    })
  }
  await Promise.race([
    shutdownTelemetry(),
    new Promise((resolve) => setTimeout(resolve, 3000).unref()),
  ])
  return process.exit(code)
}

// Synapse-owned crash semantics, uniform in BOTH configs (Sentry's
// OnUncaughtException/OnUnhandledRejection defaults are filtered out above —
// Sentry-on used to silently flip unhandledRejection to warn-and-continue):
// capture, flush (bounded), exit 1.
process.on("uncaughtException", (err) => {
  void fatalExit(err, "uncaughtException")
})
process.on("unhandledRejection", (reason) => {
  void fatalExit(reason, "unhandledRejection")
})
