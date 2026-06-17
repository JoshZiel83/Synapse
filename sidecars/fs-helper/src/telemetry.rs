//! OpenTelemetry OTLP span export (P7 — distributed-trace continuity).
//!
//! Gated on `OTEL_EXPORTER_OTLP_ENDPOINT`: when unset the fs-helper runs with
//! structured `tracing` logs to stderr only and emits no spans. When set, each
//! inbound RPC frame opens a span parented by the W3C `traceparent` the
//! device-runtime stamps on the frame, so this helper's work joins the
//! originating tool call's distributed trace:
//!
//!   api (fastify) → device-runtime (mcp-host) → fs-helper sidecar
//!
//! The exporter reads the standard `OTEL_EXPORTER_OTLP_*` env itself (endpoint,
//! headers, protocol) — matching the cua (Go) and mijia (Python) sidecars — so
//! the same compose-level config drives every hop.

use opentelemetry::global;
use opentelemetry::propagation::{Extractor, TextMapPropagator};
use opentelemetry::trace::Tracer;
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::trace::SdkTracerProvider;
use opentelemetry_sdk::Resource;

const TRACER_NAME: &str = "synapse-device-fs-helper";

/// Initialize OTLP span export when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
///
/// Returns the provider so `main()` can flush + shut it down on a clean exit
/// (stdin close); `None` when telemetry is disabled. The default OTLP feature
/// set gives an `http/proto` exporter over blocking reqwest, driven by the
/// SDK's dedicated batch-processor thread — so this needs no tokio runtime
/// feature and never blocks the async dispatch loop.
pub fn init_tracing() -> Option<SdkTracerProvider> {
    let endpoint = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok()?;
    if endpoint.trim().is_empty() {
        return None;
    }

    let exporter = match opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .build()
    {
        Ok(e) => e,
        Err(err) => {
            tracing::warn!(error = %err, "otel exporter init failed; spans disabled");
            return None;
        }
    };

    let service_name =
        std::env::var("OTEL_SERVICE_NAME").unwrap_or_else(|_| "fs-helper".to_string());
    let provider = SdkTracerProvider::builder()
        .with_batch_exporter(exporter)
        .with_resource(Resource::builder().with_service_name(service_name).build())
        .build();

    global::set_tracer_provider(provider.clone());
    global::set_text_map_propagator(TraceContextPropagator::new());
    tracing::info!(endpoint = %endpoint, "otel span export enabled");
    Some(provider)
}

/// Single-header W3C carrier for the per-frame `traceparent`. The device-runtime
/// sends only `traceparent` (no `tracestate`/baggage), so a one-key extractor is
/// all the propagator needs.
struct TraceparentCarrier<'a>(&'a str);

impl Extractor for TraceparentCarrier<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        if key.eq_ignore_ascii_case("traceparent") {
            Some(self.0)
        } else {
            None
        }
    }
    fn keys(&self) -> Vec<&str> {
        vec!["traceparent"]
    }
}

/// Start a span for one RPC method, parented by the inbound `traceparent` when
/// present. The caller drops the returned span at the end of the frame to record
/// its duration. When telemetry is disabled the global provider is a no-op, so
/// this is cheap and always safe to call on the hot path.
pub fn rpc_span(method: &str, traceparent: Option<&str>) -> global::BoxedSpan {
    let tracer = global::tracer(TRACER_NAME);
    let name = format!("fs-helper {method}");
    match traceparent {
        Some(tp) if !tp.is_empty() => {
            let propagator = TraceContextPropagator::new();
            let cx = propagator.extract(&TraceparentCarrier(tp));
            tracer.start_with_context(name, &cx)
        }
        _ => tracer.start(name),
    }
}
