"""Fast pytest for `_shared/tracing.py`'s pure-Python env handling (§4.E).

Pins the load-bearing ORDERING the P-E probe proves at the pins
(packages/api/scripts/trace-probes/p-e-fastapi-sidecars.py): scrub of
set-but-empty compose-passthrough vars happens BEFORE the endpoint gate AND
before the SDK reads the environment; the gate accepts either endpoint var
(the C9e parity fix); the semconv opt-in is defaulted, never clobbered.

The enabled-path tests inject FAKE opentelemetry modules into sys.modules so
this suite needs NO OTel install (setup_tracing's imports are all lazy) — a
regression like gate-before-scrub re-introduces the C9e/poisoning bugs and
fails here without docker or a pinned venv.

Run: python3 -m pytest sidecars/_shared/tests/
"""

from __future__ import annotations

import os
import sys
import types
from pathlib import Path

# parents[0]=tests  [1]=_shared  [2]=sidecars
SIDECARS = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SIDECARS))

from _shared import tracing  # noqa: E402

ALL_PASSTHROUGH_VARS = (
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_SDK_DISABLED",
    "OTEL_TRACES_SAMPLER",
    "OTEL_TRACES_SAMPLER_ARG",
    "OTEL_RESOURCE_ATTRIBUTES",
)


def _reset(monkeypatch):
    """Fresh module state + env for one scenario."""
    monkeypatch.setattr(tracing, "_initialized", False)
    for var in ALL_PASSTHROUGH_VARS + ("OTEL_SEMCONV_STABILITY_OPT_IN",):
        monkeypatch.delenv(var, raising=False)


class _FakeExporter:
    """Records the env the SDK would read AT CONSTRUCTION — the scrub must
    have already run by then (scrub-before-SDK-read ordering)."""

    last_seen_traces_endpoint: str | None = "NEVER-CONSTRUCTED"

    def __init__(self):
        _FakeExporter.last_seen_traces_endpoint = os.environ.get(
            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"
        )


def _install_fake_otel(monkeypatch):
    """Register fake opentelemetry modules for setup_tracing's lazy imports."""

    def module(name: str, **attrs) -> types.ModuleType:
        mod = types.ModuleType(name)
        for key, value in attrs.items():
            setattr(mod, key, value)
        monkeypatch.setitem(sys.modules, name, mod)
        return mod

    class FakeResource:
        @staticmethod
        def create(attrs):
            return {"attrs": attrs}

    class FakeProvider:
        def __init__(self, resource=None):
            self.resource = resource
            self.processors = []

        def add_span_processor(self, processor):
            self.processors.append(processor)

    trace_mod = module(
        "opentelemetry.trace", set_tracer_provider=lambda provider: None
    )
    module("opentelemetry", trace=trace_mod)
    module("opentelemetry.exporter")
    module("opentelemetry.exporter.otlp")
    module("opentelemetry.exporter.otlp.proto")
    module("opentelemetry.exporter.otlp.proto.http")
    module(
        "opentelemetry.exporter.otlp.proto.http.trace_exporter",
        OTLPSpanExporter=_FakeExporter,
    )
    module("opentelemetry.sdk")
    module("opentelemetry.sdk.resources", Resource=FakeResource)
    module("opentelemetry.sdk.trace", TracerProvider=FakeProvider)
    module(
        "opentelemetry.sdk.trace.export",
        BatchSpanProcessor=lambda exporter: ("batch", exporter),
    )


def test_all_empty_vars_disable_and_are_scrubbed(monkeypatch):
    """Set-but-empty everything (the compose `${VAR:-}` idiom) ⇒ disabled,
    and EVERY empty passthrough var is scrubbed back to unset."""
    _reset(monkeypatch)
    for var in ALL_PASSTHROUGH_VARS:
        monkeypatch.setenv(var, "")

    assert tracing.setup_tracing("test") is False
    for var in ALL_PASSTHROUGH_VARS:
        assert var not in os.environ, f"{var} must be scrubbed back to unset"
    # Disabled ⇒ the helpers are safe no-ops (and import no SDK).
    assert tracing.current_span() is None
    assert tracing.instrument_app(object()) is None
    with tracing.client_span("PUT", "http://tika:9998/tika") as span:
        assert span is None


def test_scrub_runs_before_gate_and_before_sdk_reads_env(monkeypatch):
    """Empty _TRACES_ENDPOINT + non-empty generic endpoint: the empty var must
    be GONE before the gate (which must still pass on the generic var) and
    before the exporter reads the environment — the poisoning fix."""
    _reset(monkeypatch)
    _install_fake_otel(monkeypatch)
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://alloy:4318")

    assert tracing.setup_tracing("test") is True
    assert "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT" not in os.environ
    assert (
        _FakeExporter.last_seen_traces_endpoint is None
    ), "the exporter must never see the set-but-empty poison value"


def test_traces_endpoint_alone_gates_on(monkeypatch):
    """The C9e parity fix: _TRACES_ENDPOINT alone (generic var unset) enables."""
    _reset(monkeypatch)
    _install_fake_otel(monkeypatch)
    monkeypatch.setenv(
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://alloy:4318/v1/traces"
    )

    assert tracing.setup_tracing("test") is True
    assert os.environ.get("OTEL_SEMCONV_STABILITY_OPT_IN") == "http"


def test_semconv_opt_in_defaulted_not_clobbered(monkeypatch):
    """A pre-set OTEL_SEMCONV_STABILITY_OPT_IN survives (setdefault, not set)."""
    _reset(monkeypatch)
    _install_fake_otel(monkeypatch)
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://alloy:4318")
    monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "http/dup")

    assert tracing.setup_tracing("test") is True
    assert os.environ.get("OTEL_SEMCONV_STABILITY_OPT_IN") == "http/dup"


def test_setup_is_idempotent(monkeypatch):
    """A second setup_tracing call short-circuits True without re-init."""
    _reset(monkeypatch)
    _install_fake_otel(monkeypatch)
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://alloy:4318")

    assert tracing.setup_tracing("test") is True
    # Poison the fake import path: a second call must not import at all.
    monkeypatch.setitem(sys.modules, "opentelemetry.sdk.trace", None)
    assert tracing.setup_tracing("test") is True
