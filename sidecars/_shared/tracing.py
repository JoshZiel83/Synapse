"""OpenTelemetry tracing for ALL Python sidecars — THE single implementation
(trace-correctness remediation §4.E).

Every sidecar imports from here: the 7 plain FastAPI sidecars (embed, ppocr,
tesseract, whisper, sherpa-asr, sherpa-asr-streaming, docextract) and the
Starlette MCP base (`_mcp_base`, which fronts mijia/notion/xhs/bilibili).
Per-sidecar tracing copies are forbidden (ratchet-enforced by
`_mcp_base/tests/ratchet_test.py`).

ENV-DRIVEN, no hardcode. Enabled when either `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
or `OTEL_EXPORTER_OTLP_ENDPOINT` is a NON-EMPTY value; otherwise a safe no-op.
Two runtime-proven footguns are handled up front:

* compose's `${VAR:-}` idiom materializes set-but-EMPTY env vars, and the
  pinned Python exporter treats a set-but-empty `_TRACES_ENDPOINT` as a real
  endpoint (`_endpoint == ''`), silently breaking export — both endpoint vars
  are scrubbed from `os.environ` when empty, BEFORE the gate;
* the gate accepts EITHER endpoint var (`_TRACES_ENDPOINT` alone resolves in
  the exporter but the old base gated only on the generic var — the C9e
  parity fix).

`OTEL_SEMCONV_STABILITY_OPT_IN=http` is defaulted so span attributes use the
STABLE HTTP semconv names only (`http.request.method`, `url.full`,
`http.response.status_code`, ...), matching the Node api's exporters.

All OTel imports are lazy: a disabled sidecar never imports the SDK. Only a
traces pipeline is configured — no metrics/logs pipelines (measured overhead
~0.26–0.4 ms/request against 40 ms–55 s endpoint latencies). stdout is
unaffected (MCP protocol); spans go over OTLP, logs over stderr.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Any, Iterator, MutableMapping
from urllib.parse import urlsplit

_initialized = False

_ENDPOINT_VARS = (
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
)

# All OTel env vars compose passes through with the `${VAR:-}` idiom, which
# materializes set-but-EMPTY values. Empty is NOT unset to the Python SDK:
# an empty _TRACES_ENDPOINT poisons the exporter's endpoint resolution and an
# empty OTEL_TRACES_SAMPLER provokes a "Couldn't recognize sampler ." warning
# at every boot (both runtime-proven at the pins) — so every empty member of
# this list is scrubbed back to unset before the SDK reads it.
_COMPOSE_PASSTHROUGH_VARS = _ENDPOINT_VARS + (
    "OTEL_SDK_DISABLED",
    "OTEL_TRACES_SAMPLER",
    "OTEL_TRACES_SAMPLER_ARG",
    "OTEL_RESOURCE_ATTRIBUTES",
)


def setup_tracing(default_service_name: str = "sidecar") -> bool:
    """Set up the global tracer provider + OTLP exporter. Idempotent. Returns
    True when tracing is enabled (an OTLP endpoint is configured)."""
    global _initialized
    if _initialized:
        return True

    # FIRST scrub set-but-empty vars (the `${VAR:-}` poisoning footgun),
    # THEN gate on either endpoint var being non-empty.
    for var in _COMPOSE_PASSTHROUGH_VARS:
        if var in os.environ and os.environ[var] == "":
            del os.environ[var]
    if not any(os.environ.get(var) for var in _ENDPOINT_VARS):
        return False

    # Stable-only HTTP semconv attribute names (parity with the Node api).
    os.environ.setdefault("OTEL_SEMCONV_STABILITY_OPT_IN", "http")

    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
        OTLPSpanExporter,
    )
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    resource = Resource.create(
        {
            "service.name": os.environ.get("OTEL_SERVICE_NAME")
            or default_service_name,
            "service.namespace": "synapse",
        }
    )
    provider = TracerProvider(resource=resource)
    # Arg-less OTLPSpanExporter() resolves OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    # (used as-is) or OTEL_EXPORTER_OTLP_ENDPOINT (+ /v1/traces) — the same
    # target as the api exporter / Alloy receiver.
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)
    _initialized = True
    return True


def instrument_app(app: Any) -> None:
    """Instrument the ASGI app so each HTTP request / WS connection becomes a
    SERVER span continuing the inbound traceparent. No-op when disabled.

    FastAPI branch (the 7 plain sidecars): `excluded_urls="healthz"` kills the
    healthcheck-probe spans; `exclude_spans=["receive","send"]` drops the
    per-ASGI-message sub-spans so one WS connection is exactly ONE SERVER span
    (both params runtime-verified at the pinned 0.63b1).

    Starlette branch (`_mcp_base`'s raw Starlette app): the pinned Starlette
    instrumentor has no exclude params — the documented knob is the
    OTEL_PYTHON_STARLETTE_EXCLUDED_URLS env var, defaulted BEFORE the lazy
    import.
    """
    if not _initialized:
        return
    try:
        from fastapi import FastAPI
    except ImportError:  # the MCP images ship starlette without fastapi
        FastAPI = None  # type: ignore[assignment]
    if FastAPI is not None and isinstance(app, FastAPI):
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

        FastAPIInstrumentor.instrument_app(
            app,
            excluded_urls="healthz",
            exclude_spans=["receive", "send"],
        )
        return

    os.environ.setdefault("OTEL_PYTHON_STARLETTE_EXCLUDED_URLS", "healthz")
    from opentelemetry.instrumentation.starlette import StarletteInstrumentor

    StarletteInstrumentor.instrument_app(app)


@contextmanager
def client_span(
    method: str,
    url: str,
    *,
    inject_into: MutableMapping[str, str] | None = None,
    name: str | None = None,
) -> Iterator[Any]:
    """Manual CLIENT span + W3C context injection for an in-container engine
    hop (e.g. docextract -> Tika). Yields the span, or None when tracing is
    disabled. `inject_into` (a headers dict) receives the `traceparent` via
    `propagate.inject` BEFORE the body runs.

    Callers that catch the hop's exceptions inside the block must report the
    outcome themselves via `set_client_response` / `set_client_error` (a
    caught exception never reaches the span); an exception that escapes the
    block is recorded + marked ERROR by the SDK context manager.
    """
    if not _initialized:
        yield None
        return

    from opentelemetry import propagate, trace
    from opentelemetry.trace import SpanKind

    host, port = _server_address(url)
    attributes: dict[str, Any] = {
        "http.request.method": method,
        "url.full": url,
    }
    if host:
        attributes["server.address"] = host
    if port is not None:
        attributes["server.port"] = port
    tracer = trace.get_tracer("synapse.sidecar")
    with tracer.start_as_current_span(
        name or method, kind=SpanKind.CLIENT, attributes=attributes
    ) as span:
        if inject_into is not None:
            propagate.inject(inject_into)
        yield span


def set_client_response(span: Any, status_code: int) -> None:
    """Record the hop's response status on a `client_span`. Per the stable
    HTTP semconv a CLIENT span with status >= 400 is an ERROR (unlike SERVER
    spans, where 4xx stays UNSET). No-op on a disabled-tracing None span."""
    if span is None:
        return
    from opentelemetry.trace import Status, StatusCode

    code = int(status_code)
    span.set_attribute("http.response.status_code", code)
    if code >= 400:
        span.set_status(Status(StatusCode.ERROR, f"HTTP {code}"))


def set_client_error(span: Any, exc: BaseException) -> None:
    """Record a caught transport-level failure (timeout / refused / reset) on
    a `client_span`. No-op on a disabled-tracing None span."""
    if span is None:
        return
    from opentelemetry.trace import Status, StatusCode

    span.record_exception(exc)
    span.set_attribute("error.type", type(exc).__qualname__)
    span.set_status(Status(StatusCode.ERROR, str(exc)))


def current_span() -> Any:
    """The active span — e.g. the ONE SERVER span the FastAPI instrumentor
    opens per WS connection — for attribute enrichment. Returns None when
    tracing is disabled (callers guard; a NonRecordingSpan when enabled but
    parentless is already a safe no-op sink)."""
    if not _initialized:
        return None
    from opentelemetry import trace

    return trace.get_current_span()


def _server_address(url: str) -> tuple[str | None, int | None]:
    try:
        parts = urlsplit(url)
        return parts.hostname, parts.port
    except ValueError:
        return None, None
