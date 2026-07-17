"""P-E (FastAPI sidecars) — §7 of docs/trace-correctness-remediation-plan-2026-07-12.md.

Runs the §4.E spike assertions at the exact sidecar pins against the REAL
shared module `sidecars/_shared/tracing.py` (committed on first use per §7 so
later phases re-run it instead of re-authoring a scratchpad script):

  - set-but-empty _TRACES_ENDPOINT poisons the pinned exporter (_endpoint == '')
    until scrubbed; setup_tracing scrubs ALL set-but-empty compose-passthrough
    vars (incl. the 4 [adj 20] additions) BEFORE the gate
  - _TRACES_ENDPOINT alone resolves (the gate accepts either endpoint var —
    the C9e parity fix)
  - OTEL_SEMCONV_STABILITY_OPT_IN defaulted to http; STABLE-only attr names
  - excluded_urls="healthz" kills healthcheck-probe spans
  - one SERVER span per HTTP request, remote-parented on the injected header
  - ONE span per WS connection, parented on the handshake header
    (exclude_spans=["receive","send"] drops per-message sub-spans)
  - contextvars.copy_context().run REQUIRED for thread propagation
    (negative control: INVALID span context on a bare thread)

Bootstrap (pinned venv — matches sidecars/*/requirements.txt):

  python3 -m venv /tmp/pe-venv && /tmp/pe-venv/bin/pip install \
    'fastapi>=0.110,<1' httpx \
    opentelemetry-sdk==1.42.1 \
    opentelemetry-exporter-otlp-proto-http==1.42.1 \
    opentelemetry-instrumentation-fastapi==0.63b1

Run (from the repo root):

  PYTHONPATH=/projects/Synapse-dev/sidecars /tmp/pe-venv/bin/python \
    packages/api/scripts/trace-probes/p-e-fastapi-sidecars.py

Exits 0 iff all 16 checks pass.
"""

import contextvars
import os
import sys
import threading

RESULTS = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail and not ok else ""))


# ── 1. set-but-empty endpoint vars: poison + scrub ──────────────────────────
os.environ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] = ""
os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] = ""
os.environ["OTEL_TRACES_SAMPLER"] = ""
os.environ["OTEL_TRACES_SAMPLER_ARG"] = ""
os.environ["OTEL_SDK_DISABLED"] = ""
os.environ["OTEL_RESOURCE_ATTRIBUTES"] = ""

# The poison itself, at the pinned exporter, BEFORE any scrub runs:
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

poisoned = OTLPSpanExporter()
check(
    "set-but-empty _TRACES_ENDPOINT poisons the pinned exporter (_endpoint == '')",
    getattr(poisoned, "_endpoint", None) == "",
    f"_endpoint={getattr(poisoned, '_endpoint', None)!r}",
)

from _shared import tracing

check(
    "setup_tracing with BOTH endpoint vars set-but-empty returns False (disabled)",
    tracing.setup_tracing("p-e-probe") is False,
)
check(
    "empty endpoint vars scrubbed back to unset",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT" not in os.environ
    and "OTEL_EXPORTER_OTLP_ENDPOINT" not in os.environ,
)
check(
    "empty [adj 20] passthrough vars scrubbed (SAMPLER/SAMPLER_ARG/SDK_DISABLED/RESOURCE_ATTRIBUTES)",
    all(
        v not in os.environ
        for v in (
            "OTEL_TRACES_SAMPLER",
            "OTEL_TRACES_SAMPLER_ARG",
            "OTEL_SDK_DISABLED",
            "OTEL_RESOURCE_ATTRIBUTES",
        )
    ),
)
check(
    "disabled: instrument_app/current_span are safe no-ops",
    tracing.current_span() is None,
)

# ── 2. _TRACES_ENDPOINT alone resolves; setup enables ───────────────────────
os.environ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] = "http://127.0.0.1:1/v1/traces"
check(
    "_TRACES_ENDPOINT alone gates tracing ON (C9e parity fix)",
    tracing.setup_tracing("p-e-probe") is True,
)
check(
    "OTEL_SEMCONV_STABILITY_OPT_IN defaulted to http",
    os.environ.get("OTEL_SEMCONV_STABILITY_OPT_IN") == "http",
)

# Attach an in-memory processor so assertions never depend on OTLP delivery.
from opentelemetry import trace
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)

mem = InMemorySpanExporter()
trace.get_tracer_provider().add_span_processor(SimpleSpanProcessor(mem))

# ── 3. FastAPI app wired exactly like the 7 sidecars ────────────────────────
from fastapi import FastAPI, WebSocket

app = FastAPI()
THREAD_RESULTS = {}


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/work")
def work():
    # thread-propagation checks run INSIDE a live request span
    current = trace.get_current_span().get_span_context()

    def read_ctx():
        return trace.get_current_span().get_span_context()

    bare: list = []
    t = threading.Thread(target=lambda: bare.append(read_ctx()))
    t.start()
    t.join()
    THREAD_RESULTS["bare_valid"] = bare[0].is_valid
    ctx = contextvars.copy_context()
    carried: list = []
    t2 = threading.Thread(target=lambda: carried.append(ctx.run(read_ctx)))
    t2.start()
    t2.join()
    THREAD_RESULTS["carried_valid"] = carried[0].is_valid
    THREAD_RESULTS["carried_matches_request"] = (
        carried[0].span_id == current.span_id
        and carried[0].trace_id == current.trace_id
    )
    return {"ok": True}


@app.websocket("/ws")
async def ws(sock: WebSocket):
    await sock.accept()
    msg = await sock.receive_text()
    await sock.send_text(msg + "!")
    msg = await sock.receive_text()
    await sock.send_text(msg + "!")
    await sock.close()


tracing.instrument_app(app)

from fastapi.testclient import TestClient

client = TestClient(app)

# healthz excluded
mem.clear()
r = client.get("/healthz")
trace.get_tracer_provider().force_flush()
check(
    'excluded_urls="healthz" kills healthcheck-probe spans',
    r.status_code == 200 and len(mem.get_finished_spans()) == 0,
    f"spans={[s.name for s in mem.get_finished_spans()]}",
)

# one SERVER span per HTTP request, remote-parented on the injected header
mem.clear()
TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
PARENT_ID = "b7ad6b7169203331"
r = client.get("/work", headers={"traceparent": f"00-{TRACE_ID}-{PARENT_ID}-01"})
trace.get_tracer_provider().force_flush()
spans = mem.get_finished_spans()
server_spans = [s for s in spans if s.kind == trace.SpanKind.SERVER]
check(
    "exactly ONE SERVER span per HTTP request",
    r.status_code == 200 and len(server_spans) == 1,
    f"spans={[(s.name, s.kind.name) for s in spans]}",
)
s0 = server_spans[0]
check(
    "HTTP SERVER span continues the injected traceparent (trace id preserved)",
    format(s0.get_span_context().trace_id, "032x") == TRACE_ID,
)
check(
    "HTTP SERVER span's parent IS the injected span id (remote parent)",
    s0.parent is not None
    and s0.parent.is_remote
    and format(s0.parent.span_id, "016x") == PARENT_ID,
)
attrs = dict(s0.attributes or {})
check(
    "STABLE-only HTTP semconv attribute names on the SERVER span",
    "http.request.method" in attrs
    and "http.response.status_code" in attrs
    and "http.method" not in attrs
    and "http.status_code" not in attrs,
    f"attrs={sorted(attrs)}",
)

# thread propagation (ran inside the /work handler above)
check(
    "negative control: bare thread sees INVALID span context",
    THREAD_RESULTS.get("bare_valid") is False,
    str(THREAD_RESULTS),
)
check(
    "contextvars.copy_context().run carries the request span into the thread",
    THREAD_RESULTS.get("carried_valid") is True
    and THREAD_RESULTS.get("carried_matches_request") is True,
    str(THREAD_RESULTS),
)

# ONE span per WS connection, parented on the handshake
mem.clear()
WS_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736"
WS_PARENT = "00f067aa0ba902b7"
with client.websocket_connect(
    "/ws", headers={"traceparent": f"00-{WS_TRACE}-{WS_PARENT}-01"}
) as sock:
    sock.send_text("a")
    assert sock.receive_text() == "a!"
    sock.send_text("b")
    assert sock.receive_text() == "b!"
trace.get_tracer_provider().force_flush()
ws_spans = mem.get_finished_spans()
check(
    "ONE span per WS connection (2 messages, zero receive/send sub-spans)",
    len(ws_spans) == 1 and ws_spans[0].kind == trace.SpanKind.SERVER,
    f"spans={[(s.name, s.kind.name) for s in ws_spans]}",
)
w0 = ws_spans[0]
check(
    "WS connection span parented on the handshake traceparent",
    format(w0.get_span_context().trace_id, "032x") == WS_TRACE
    and w0.parent is not None
    and w0.parent.is_remote
    and format(w0.parent.span_id, "016x") == WS_PARENT,
)

failed = [n for (n, ok, _) in RESULTS if not ok]
print(f"\nP-E: {len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
sys.exit(1 if failed else 0)
