/**
 * OpenTelemetry tracing bootstrap (+ optional Sentry).
 *
 * Imported as the VERY FIRST import of src/index.ts so the HTTP instrumentation
 * patches node:http before the Fastify server / outbound HTTP clients are
 * created. (For the strictest patching you can instead preload it:
 *   node --import ./dist/instrumentation.js dist/index.js
 * — the import-first approach is equivalent for our needs because log↔trace
 * correlation does NOT rely on module patching; it is read live from the active
 * span via the pino `mixin` in infrastructure/logger.)
 *
 * Everything is ENV-DRIVEN — nothing (DSN, endpoint, service name) is hardcoded,
 * so this stays correct for an open-source deployment where operators set their
 * own hosts via env:
 *   OTEL_EXPORTER_OTLP_ENDPOINT   base OTLP/HTTP endpoint (e.g. http://alloy:4318);
 *                                 traces are POSTed to <endpoint>/v1/traces.
 *   OTEL_SERVICE_NAME             service.name resource attribute (default "synapse-api").
 *   SENTRY_DSN                    if set, Sentry error+trace capture is enabled.
 *   SENTRY_ENVIRONMENT            Sentry environment (default NODE_ENV).
 *   SENTRY_TRACES_SAMPLE_RATE     Sentry trace sample rate (default 0.1).
 *
 * If neither OTLP nor Sentry is configured, spans are still created (so logs
 * carry trace_id) but nothing is exported — a safe no-backend default.
 */
import "./infrastructure/env-bootstrap.js"

import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { registerInstrumentations } from "@opentelemetry/instrumentation"
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http"
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici"
import { resourceFromAttributes } from "@opentelemetry/resources"
import {
  BatchSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions"
import { FastifyOtelInstrumentation } from "@fastify/otel"
import * as Sentry from "@sentry/node"
import {
  SentryPropagator,
  SentrySampler,
  SentrySpanProcessor,
} from "@sentry/opentelemetry"

const serviceName = process.env.OTEL_SERVICE_NAME || "synapse-api"
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
const sentryDsn = process.env.SENTRY_DSN

const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: serviceName,
  "service.namespace": "synapse",
})

const spanProcessors: SpanProcessor[] = []

// OTLP export (traces -> Grafana Alloy -> Tempo). Constructed with no args so it
// reads OTEL_EXPORTER_OTLP_ENDPOINT from the environment.
if (otlpEndpoint) {
  spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter()))
}

// Sentry (optional, gated on SENTRY_DSN). @sentry/node v10 is built on
// OpenTelemetry; we keep ONE shared trace context by registering Sentry as a
// span processor + propagator + sampler + context manager on OUR provider
// (skipOpenTelemetrySetup), so spans flow to BOTH Sentry and the OTLP backend
// under a single trace_id. See docs.sentry.io .../node/opentelemetry/custom-setup/.
const sentryClient = sentryDsn
  ? Sentry.init({
      dsn: sentryDsn,
      environment:
        process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
      // http integration with spans OFF: we want Sentry's per-request isolation
      // scope, but spans come from our own provider (@fastify/otel + OTLP), so
      // Sentry must not also create http spans (would double-count).
      integrations: [Sentry.httpIntegration({ spans: false })],
      // We own the OTel setup below; do not let Sentry auto-configure it or
      // register ESM loader hooks (we manage instrumentation ourselves).
      skipOpenTelemetrySetup: true,
      registerEsmLoaderHooks: false,
    })
  : undefined

if (sentryClient) {
  spanProcessors.push(new SentrySpanProcessor())
}

const provider = new NodeTracerProvider({
  resource,
  ...(sentryClient ? { sampler: new SentrySampler(sentryClient) } : {}),
  spanProcessors,
})

// The global propagator ALWAYS speaks W3C `traceparent` (inject + extract), in
// BOTH configs, so a single W3C trace context crosses every process boundary
// regardless of Sentry:
//   - Sentry OFF: W3C trace-context + baggage.
//   - Sentry ON:  SentryPropagator (sentry-trace/baggage — it extends
//     W3CBaggagePropagator, so baggage is its job) COMPOSED WITH
//     W3CTraceContextPropagator (traceparent only — no baggage double-write).
//     Without the W3C member, SentryPropagator neither emits (propagateTraceparent
//     defaults false) nor extracts W3C `traceparent`, which would sever the
//     Python sidecars, the remote-agent daemon callbacks, and every OTLP-only
//     peer that speaks W3C. Composing restores W3C both directions while keeping
//     Sentry's own sentry-trace continuity.
provider.register(
  sentryClient
    ? {
        propagator: new CompositePropagator({
          propagators: [
            new SentryPropagator(),
            new W3CTraceContextPropagator(),
          ],
        }),
        contextManager: new Sentry.SentryContextManager(),
      }
    : {
        propagator: new CompositePropagator({
          propagators: [
            new W3CTraceContextPropagator(),
            new W3CBaggagePropagator(),
          ],
        }),
        contextManager: new AsyncLocalStorageContextManager(),
      }
)

registerInstrumentations({
  tracerProvider: provider,
  instrumentations: [
    // Patches node:http so inbound requests start a root span (continuing any
    // inbound W3C traceparent) and outbound http/https calls propagate it.
    // @fastify/otel builds on this for route-level spans. (Log↔trace
    // correlation is handled by the pino mixin, not by instrumentation-pino.)
    new HttpInstrumentation(),
    // Patches undici / global `fetch` (which node:http does NOT cover). Node's
    // global fetch is undici-based, and the MCP SDK + every FastAPI sidecar
    // client (embedding / OCR / transcription / document-extraction / remote
    // MCP) POST over it — without this their outbound requests carry no
    // traceparent and each sidecar opens a fresh-root SERVER span. This makes
    // W3C-injection automatic for ALL fetch egress via the global propagator
    // above (correct under Sentry-on and -off).
    new UndiciInstrumentation(),
  ],
})

if (sentryClient) {
  Sentry.validateOpenTelemetrySetup()
}

// Fastify route/handler/hook spans. Registered on the app in index.ts via
// `await app.register(fastifyOtelInstrumentation.plugin())` BEFORE routes.
const fastifyOtelInstrumentation = new FastifyOtelInstrumentation()
fastifyOtelInstrumentation.setTracerProvider(provider)

export { fastifyOtelInstrumentation }

/** True when Sentry is enabled (SENTRY_DSN set). */
export const sentryEnabled = Boolean(sentryClient)

/**
 * Register Sentry's Fastify error handler. Fastify v4 requires this to be set up
 * explicitly or route errors never reach Sentry. No-op when Sentry is disabled.
 */
export function setupSentryErrorHandler(
  app: Parameters<typeof Sentry.setupFastifyErrorHandler>[0]
): void {
  if (sentryClient) Sentry.setupFastifyErrorHandler(app)
}

/**
 * Flush + shut down telemetry on graceful shutdown so buffered spans/events are
 * not lost on SIGTERM. Best-effort: never throws.
 */
export async function shutdownTelemetry(): Promise<void> {
  try {
    await provider.forceFlush()
  } catch {
    /* best-effort */
  }
  try {
    await provider.shutdown()
  } catch {
    /* best-effort */
  }
  if (sentryClient) {
    try {
      await Sentry.close(2000)
    } catch {
      /* best-effort */
    }
  }
}
