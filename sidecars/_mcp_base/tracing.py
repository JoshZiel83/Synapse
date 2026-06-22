"""OpenTelemetry tracing for the shared mcp sidecar base (logging refactor P7).

Copied verbatim from the mijia sidecar's tracing.py; only the service-name
default differs (now driven by ``AdapterConfig.service_name`` via the
OTEL_SERVICE_NAME env the base sets, with a generic fallback).

ENV-DRIVEN, no hardcode. Enabled only when OTEL_EXPORTER_OTLP_ENDPOINT is set
(e.g. http://alloy:4318); otherwise a safe no-op. The api injects a W3C
`traceparent` on its outbound HTTP to this sidecar, so StarletteInstrumentor
auto-continues that trace and exports request spans to the collector under one
trace_id — making the sidecar part of the cross-process span tree.

stdout is unaffected (MCP protocol); spans go over OTLP, logs over stderr.
"""

from __future__ import annotations

import os

from starlette.applications import Starlette

_initialized = False


def setup_tracing(default_service_name: str = "mcp-sidecar") -> bool:
    """Set up the global tracer provider + OTLP exporter. Idempotent. Returns
    True when tracing is enabled (OTEL endpoint configured)."""
    global _initialized
    if _initialized:
        return True
    if not os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
        return False

    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
        OTLPSpanExporter,
    )
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    resource = Resource.create(
        {
            "service.name": os.environ.get("OTEL_SERVICE_NAME", default_service_name),
            "service.namespace": "synapse",
        }
    )
    provider = TracerProvider(resource=resource)
    # OTLPSpanExporter() reads OTEL_EXPORTER_OTLP_ENDPOINT and POSTs to
    # <endpoint>/v1/traces (same target as the api exporter / Alloy receiver).
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)
    _initialized = True
    return True


def instrument_app(app: Starlette) -> None:
    """Instrument the Starlette app so each request becomes a span continuing
    the inbound traceparent. No-op when tracing is disabled."""
    if not _initialized:
        return
    from opentelemetry.instrumentation.starlette import StarletteInstrumentor

    StarletteInstrumentor.instrument_app(app)
