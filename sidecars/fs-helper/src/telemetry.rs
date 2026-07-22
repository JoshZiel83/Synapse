//! OpenTelemetry OTLP span export (P7 — distributed-trace continuity).
//!
//! Gated on `OTEL_EXPORTER_OTLP_ENDPOINT`: when unset the fs-helper runs with
//! structured `tracing` logs to stderr only and emits no spans. When set, each
//! inbound RPC frame opens a span parented by the W3C `{traceparent,
//! tracestate?}` carrier the device-runtime stamps on the frame (§3c), so this
//! helper's work joins the originating tool call's distributed trace:
//!
//!   api (fastify) → device-runtime (mcp-host) → fs-helper sidecar
//!
//! The exporter reads the standard `OTEL_EXPORTER_OTLP_*` env itself (endpoint,
//! headers, protocol) — matching the cua (Go) and mijia (Python) sidecars — so
//! the same compose-level config drives every hop.

use std::sync::OnceLock;

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

// ─── synapse-trace-contract v2 (sanctioned literal duplicate) ───────────────
//
// Canonical artifact: packages/shared/src/utils/traceparent.ts. The guard
// scripts/guard-trace-propagation.mjs (rule carrier_contract_drift) byte-
// compares the two values below against the canonical file and asserts the
// numeric const matches. Mirror any change to the canonical file here:
//
//   TRACEPARENT_RE = /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/
//   MAX_TRACESTATE_LENGTH = 512
//
// This helper pins ONLY traceparent + the 512 cap: opentelemetry 0.32.0's
// TraceState::from_str drops the WHOLE tracestate on any parse error while
// keeping the traceparent — exactly our whole-or-nothing contract — so
// re-implementing the ABNF here would be drift for no gain. (Divergences from
// the canonical gate, documented in docs/trace-propagation-policy.md:
// opentelemetry 0.32.0 does NOT reject duplicate keys and enforces NO member
// cap.) Rust has no lookahead in `std` (no regex dep), so `valid_traceparent`
// rejects the all-zero trace-id/span-id by character checks instead of via
// (?!0{32}). Receiver rule: a malformed/oversized value degrades to ABSENT
// (root span); `tracestate` is honored only alongside a valid `traceparent`
// and only up to MAX_TRACESTATE_LENGTH.

const MAX_TRACESTATE_LENGTH: usize = 512;

// One reusable extractor instance for the whole process (the propagator is
// stateless, so per-RPC construction was a hot-path micro-allocation only).
// Deliberately NOT `global::get_text_map_propagator`: when telemetry is
// disabled the global default is an empty composite whose extract is a no-op,
// and this module's contract is that extraction semantics never depend on
// whether init_tracing ran (the noop tracer discards the parent either way).
static PROPAGATOR: OnceLock<TraceContextPropagator> = OnceLock::new();

/// Strict version-00 W3C traceparent check (see the pinned literal above).
fn valid_traceparent(value: &str) -> bool {
    let b = value.as_bytes();
    if b.len() != 55 || &b[0..3] != b"00-" || b[35] != b'-' || b[52] != b'-' {
        return false;
    }
    let lower_hex = |s: &[u8]| s.iter().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c));
    let trace_id = &b[3..35];
    let span_id = &b[36..52];
    lower_hex(trace_id)
        && lower_hex(span_id)
        && lower_hex(&b[53..55])
        && trace_id.iter().any(|c| *c != b'0')
        && span_id.iter().any(|c| *c != b'0')
}

/// Two-key W3C carrier for the per-frame `{traceparent, tracestate?}` pair the
/// device-runtime stamps on JSON-RPC frames (§3c). `tracestate` vendor members
/// ride along so they survive this hop.
struct FrameCarrier<'a> {
    traceparent: &'a str,
    tracestate: Option<&'a str>,
}

impl Extractor for FrameCarrier<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        if key.eq_ignore_ascii_case("traceparent") {
            Some(self.traceparent)
        } else if key.eq_ignore_ascii_case("tracestate") {
            self.tracestate
        } else {
            None
        }
    }
    fn keys(&self) -> Vec<&str> {
        vec!["traceparent", "tracestate"]
    }
}

/// Start a span for one RPC method, parented by the inbound `{traceparent,
/// tracestate?}` carrier when present + valid (garbage degrades to a root
/// span). The caller drops the returned span at the end of the frame to record
/// its duration. When telemetry is disabled the global provider is a no-op, so
/// this is cheap and always safe to call on the hot path.
pub fn rpc_span(
    method: &str,
    traceparent: Option<&str>,
    tracestate: Option<&str>,
) -> global::BoxedSpan {
    let tracer = global::tracer(TRACER_NAME);
    let name = format!("fs-helper {method}");
    match traceparent {
        Some(tp) if valid_traceparent(tp) => {
            let cx = PROPAGATOR
                .get_or_init(TraceContextPropagator::new)
                .extract(&FrameCarrier {
                    traceparent: tp,
                    tracestate: accepted_tracestate(tracestate),
                });
            tracer.start_with_context(name, &cx)
        }
        _ => tracer.start(name),
    }
}

/// The §3c tracestate acceptance filter: honored only non-empty and within
/// MAX_TRACESTATE_LENGTH; anything else degrades to ABSENT (the traceparent
/// still parents the span). Split out of `rpc_span` for unit tests.
fn accepted_tracestate(tracestate: Option<&str>) -> Option<&str> {
    tracestate.filter(|ts| !ts.is_empty() && ts.len() <= MAX_TRACESTATE_LENGTH)
}

#[cfg(test)]
mod tests {
    use super::{
        accepted_tracestate, valid_traceparent, FrameCarrier, MAX_TRACESTATE_LENGTH,
    };
    use opentelemetry::propagation::{Extractor, TextMapPropagator};
    use opentelemetry::trace::TraceContextExt;
    use opentelemetry_sdk::propagation::TraceContextPropagator;

    #[test]
    fn tracestate_filter_gates_empty_and_oversized() {
        assert_eq!(accepted_tracestate(None), None);
        assert_eq!(accepted_tracestate(Some("")), None);
        let at_cap = "a".repeat(MAX_TRACESTATE_LENGTH);
        assert_eq!(
            accepted_tracestate(Some(&at_cap)),
            Some(at_cap.as_str()),
            "a tracestate AT the cap (512) is honored"
        );
        let over = "a".repeat(MAX_TRACESTATE_LENGTH + 1);
        assert_eq!(
            accepted_tracestate(Some(&over)),
            None,
            "an oversized tracestate degrades to ABSENT"
        );
        assert_eq!(accepted_tracestate(Some("es=s:1.0")), Some("es=s:1.0"));
    }

    #[test]
    fn frame_carrier_is_case_insensitive_and_two_key() {
        let carrier = FrameCarrier {
            traceparent: "tp",
            tracestate: Some("ts"),
        };
        assert_eq!(carrier.get("traceparent"), Some("tp"));
        assert_eq!(carrier.get("TraceParent"), Some("tp"));
        assert_eq!(carrier.get("tracestate"), Some("ts"));
        assert_eq!(carrier.get("TRACESTATE"), Some("ts"));
        assert_eq!(carrier.get("baggage"), None);
        let none_state = FrameCarrier {
            traceparent: "tp",
            tracestate: None,
        };
        assert_eq!(none_state.get("tracestate"), None);
        let mut keys = carrier.keys();
        keys.sort_unstable();
        assert_eq!(keys, vec!["traceparent", "tracestate"]);
    }

    #[test]
    fn extract_parents_on_the_carrier_and_preserves_tracestate() {
        // Pin that a valid {traceparent, tracestate} pair fed through the
        // carrier yields a REMOTE parent with the exact trace id and the
        // vendor tracestate intact (the propagator's own W3C re-validation
        // accepted it).
        let cx = TraceContextPropagator::new().extract(&FrameCarrier {
            traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
            tracestate: Some("es=s:1.0"),
        });
        let span = cx.span();
        let sc = span.span_context();
        assert!(sc.is_valid());
        assert!(sc.is_remote());
        assert_eq!(
            sc.trace_id().to_string(),
            "0af7651916cd43dd8448eb211c80319c"
        );
        assert_eq!(sc.span_id().to_string(), "b7ad6b7169203331");
        assert_eq!(sc.trace_state().header(), "es=s:1.0");
    }

    #[test]
    fn traceparent_validation_matches_the_pinned_regex() {
        // valid
        assert!(valid_traceparent(
            "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
        ));
        // wrong version / garbage / casing / all-zero ids / length
        assert!(!valid_traceparent(
            "ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
        ));
        assert!(!valid_traceparent(
            "00-0AF7651916CD43DD8448EB211C80319C-B7AD6B7169203331-01"
        ));
        assert!(!valid_traceparent(
            "00-00000000000000000000000000000000-b7ad6b7169203331-01"
        ));
        assert!(!valid_traceparent(
            "00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01"
        ));
        assert!(!valid_traceparent("garbage"));
        assert!(!valid_traceparent(""));
        assert!(!valid_traceparent(
            "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01-extra"
        ));
    }

    // Drives the SAME cross-language JSON the TS and Go tests read, so all three
    // languages assert identical behaviour on identical inputs. `valid_traceparent`
    // must match `accept`; `accepted_tracestate` (non-empty + within the cap — the
    // ABNF whole-or-nothing is opentelemetry's job) must match `capOnly`. The read
    // lives in `#[cfg(test)]`, so `cargo build` and the Docker image are unaffected.
    #[test]
    fn golden_vectors_match_the_shared_json() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/shared/src/utils/traceparent-vectors.json"
        );
        let raw = std::fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("read golden vectors {path}: {e}"));
        let vectors: serde_json::Value = serde_json::from_str(&raw).expect("parse vectors");

        let tps = vectors["traceparent"].as_array().expect("traceparent array");
        assert!(!tps.is_empty(), "traceparent vectors empty");
        for v in tps {
            let value = v["v"].as_str().unwrap();
            let accept = v["accept"].as_bool().unwrap();
            assert_eq!(
                valid_traceparent(value),
                accept,
                "traceparent {value:?} ({})",
                v["note"].as_str().unwrap_or("")
            );
        }

        let tss = vectors["tracestate"].as_array().expect("tracestate array");
        assert!(!tss.is_empty(), "tracestate vectors empty");
        for v in tss {
            let value = v["v"].as_str().unwrap();
            let cap_only = v["capOnly"].as_bool().unwrap();
            assert_eq!(
                accepted_tracestate(Some(value)).is_some(),
                cap_only,
                "tracestate {value:?} ({})",
                v["note"].as_str().unwrap_or("")
            );
        }
    }
}
