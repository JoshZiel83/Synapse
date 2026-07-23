"""P-G3 (Go/Rust helper JSON-RPC span semconv) — §7 of
docs/trace-correctness-remediation-plan-2026-07-12.md.

The verify-F9 runtime technique, made repeatable and dependency-free. For EACH
stdio helper (cua = Go, fs-helper = Rust) this:

  1. Starts a throwaway OTLP/HTTP sink on a free loopback port (stdlib
     http.server; NO opentelemetry SDK — a ~90-line protobuf field walker
     decodes the ExportTraceServiceRequest bytes directly). Nothing in the repo
     or the live stack is touched, restarted, or depended on.
  2. Spawns the prebuilt helper with OTEL_EXPORTER_OTLP_ENDPOINT pointed at the
     sink, then feeds three JSON-RPC frames — a RECOGNIZED method, an
     UNKNOWN method, and an UNPARSABLE line — the first two carrying a fixed
     W3C traceparent.
  3. Closes stdin (the clean EOF flush path) and asserts the exported spans:
       - span kind == SERVER (2)   [F9a: was INTERNAL]
       - the RECOGNIZED frame's span is named {method}, status UNSET,
         rpc.method={method}, and continues the injected trace as a remote child
       - the UNKNOWN + UNPARSABLE frames are named "jsonrpc", status ERROR,
         rpc.method=_OTHER, rpc.method_original set only on the unknown frame,
         rpc.response.status_code + error.type = the decimal JSON-RPC code
       - the creation attrs rpc.system.name=jsonrpc / jsonrpc.protocol.version=2.0
         / network.transport=pipe are present on every span
       - jsonrpc.request.id rides ONLY on the frame that carried an id
  4. PHASE 2 — the regression test for the span-loss class the review missed:
     re-spawns the helper, feeds a frame, and stops it with SIGTERM (NOT stdin
     close). The old binaries installed no signal handler and dropped every
     buffered span; the fixed helpers flush on SIGTERM, so the span must still
     arrive and the process must exit within a few seconds.

Binaries resolve from SYNAPSE_DEVICE_CUA_HELPER_PATH /
SYNAPSE_DEVICE_FS_HELPER_PATH, else the repo-relative release defaults; a helper
that is absent (npm install ships none by design — F9c) is SKIPPED with a clear
message, not failed.

Run (from the repo root; no venv, no deps):

  python3 packages/api/scripts/trace-probes/p-g3-helper-rpc-semconv.py

Exits 0 iff every present helper passes; 0 with a note if both are absent.
"""

import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))

CARRIER_TRACE_ID = "11111111111111111111111111111111"
CARRIER_SPAN_ID = "2222222222222222"
CARRIER_TP = f"00-{CARRIER_TRACE_ID}-{CARRIER_SPAN_ID}-01"

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail and not ok else ""))


# ── protobuf field walker (no deps) ─────────────────────────────────────────
def _read_varint(buf, i):
    shift = 0
    val = 0
    while True:
        b = buf[i]
        i += 1
        val |= (b & 0x7F) << shift
        if not (b & 0x80):
            return val, i
        shift += 7


def parse_fields(buf):
    """Return {field_number: [raw_value, ...]}. Length-delimited → bytes,
    varint → int, fixed64 → 8 bytes, fixed32 → 4 bytes."""
    out = {}
    i = 0
    n = len(buf)
    while i < n:
        tag, i = _read_varint(buf, i)
        field = tag >> 3
        wire = tag & 0x7
        if wire == 0:
            val, i = _read_varint(buf, i)
        elif wire == 1:
            val = buf[i : i + 8]
            i += 8
        elif wire == 2:
            ln, i = _read_varint(buf, i)
            val = buf[i : i + ln]
            i += ln
        elif wire == 5:
            val = buf[i : i + 4]
            i += 4
        else:
            raise ValueError(f"unsupported wire type {wire}")
        out.setdefault(field, []).append(val)
    return out


def _s(b):
    return b.decode("utf-8", "replace") if isinstance(b, (bytes, bytearray)) else b


def anyvalue_str(raw):
    f = parse_fields(raw)
    if 1 in f:  # string_value
        return _s(f[1][0])
    if 2 in f:  # bool_value
        return "true" if f[2][0] else "false"
    if 3 in f:  # int_value
        return str(f[3][0])
    if 4 in f:  # double_value
        return str(f[4][0])
    return ""


def decode_spans(body):
    """ExportTraceServiceRequest → list of span dicts."""
    spans = []
    req = parse_fields(body)
    for rs in req.get(1, []):  # resource_spans
        for ss in parse_fields(rs).get(2, []):  # scope_spans
            for sp in parse_fields(ss).get(2, []):  # spans
                f = parse_fields(sp)
                attrs = {}
                for kv in f.get(9, []):  # attributes
                    kvf = parse_fields(kv)
                    key = _s(kvf[1][0]) if 1 in kvf else ""
                    value = anyvalue_str(kvf[2][0]) if 2 in kvf else ""
                    attrs[key] = value
                status_code = 0
                status_msg = ""
                if 15 in f:  # status
                    stf = parse_fields(f[15][0])
                    status_msg = _s(stf[2][0]) if 2 in stf else ""
                    status_code = stf[3][0] if 3 in stf else 0
                spans.append(
                    {
                        "trace_id": f[1][0].hex() if 1 in f else "",
                        "span_id": f[2][0].hex() if 2 in f else "",
                        "parent_span_id": f[4][0].hex() if 4 in f else "",
                        "name": _s(f[5][0]) if 5 in f else "",
                        "kind": f[6][0] if 6 in f else 0,
                        "status_code": status_code,
                        "status_msg": status_msg,
                        "attrs": attrs,
                    }
                )
    return spans


# ── throwaway OTLP/HTTP sink ─────────────────────────────────────────────────
class Sink:
    def __init__(self):
        self.spans = []
        self._lock = threading.Lock()
        sink = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length)
                try:
                    decoded = decode_spans(body)
                except Exception as e:  # noqa: BLE001
                    decoded = []
                    print(f"  (sink decode error: {e})")
                with sink._lock:
                    sink.spans.extend(decoded)
                # Minimal ExportTraceServiceResponse (empty) + 200.
                self.send_response(200)
                self.send_header("Content-Type", "application/x-protobuf")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *_):
                pass

        self._server = HTTPServer(("127.0.0.1", 0), Handler)
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def endpoint(self):
        return f"http://127.0.0.1:{self.port}"

    def wait_for_spans(self, count, timeout=6.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._lock:
                if len(self.spans) >= count:
                    break
            time.sleep(0.05)
        with self._lock:
            return list(self.spans)

    def reset(self):
        with self._lock:
            self.spans = []

    def close(self):
        self._server.shutdown()


def free_endpoint_env(sink):
    env = dict(os.environ)
    env["OTEL_EXPORTER_OTLP_ENDPOINT"] = sink.endpoint()
    env["OTEL_EXPORTER_OTLP_PROTOCOL"] = "http/protobuf"
    env.pop("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", None)
    env["OTEL_SERVICE_NAME"] = "p-g3-probe"
    return env


def resolve_binary(env_var, default_rel):
    p = os.environ.get(env_var)
    if p and os.path.exists(p):
        return p
    default = os.path.join(REPO_ROOT, default_rel)
    return default if os.path.exists(default) else None


# ── per-helper assertions ────────────────────────────────────────────────────
def by_method(spans):
    """Index spans by rpc.method_original (unknown) / rpc.method (known) /
    name for lookup."""
    return spans


def run_helper(label, binary, args, recognized_method, unknown_method):
    print(f"\n── {label} ({binary}) ──")
    sink = Sink()
    env = free_endpoint_env(sink)

    # PHASE 1: three frames, clean stdin-close flush.
    frames = [
        # recognized method WITH a carrier and an id → named, UNSET.
        f'{{"jsonrpc":"2.0","id":7,"method":"{recognized_method}","traceparent":"{CARRIER_TP}"}}',
        # unknown method WITH a carrier and an id → _OTHER, ERROR -32601.
        f'{{"jsonrpc":"2.0","id":8,"method":"{unknown_method}","traceparent":"{CARRIER_TP}"}}',
        # unparsable line → _OTHER, ERROR -32700, no id, root span.
        "not json at all",
    ]
    proc = subprocess.Popen(
        [binary, *args],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=env,
    )
    proc.stdin.write(("\n".join(frames) + "\n").encode())
    proc.stdin.flush()
    proc.stdin.close()  # EOF → clean flush path
    try:
        proc.wait(timeout=6)
    except subprocess.TimeoutExpired:
        proc.kill()
    spans = sink.wait_for_spans(3)

    check(f"{label}: exactly 3 spans exported over OTLP", len(spans) == 3,
          f"got {len(spans)}: {[s['name'] for s in spans]}")
    if len(spans) < 3:
        sink.close()
        return

    for s in spans:
        check(f"{label}: span {s['name']!r} kind==SERVER(2)", s["kind"] == 2,
              f"kind={s['kind']}")
        a = s["attrs"]
        check(f"{label}: span {s['name']!r} creation attrs present",
              a.get("rpc.system.name") == "jsonrpc"
              and a.get("jsonrpc.protocol.version") == "2.0"
              and a.get("network.transport") == "pipe",
              f"attrs={sorted(a)}")

    # recognized
    rec = [s for s in spans if s["name"] == recognized_method]
    check(f"{label}: recognized {recognized_method!r} → 1 named span", len(rec) == 1,
          f"names={[s['name'] for s in spans]}")
    if rec:
        r = rec[0]
        check(f"{label}: recognized span status UNSET", r["status_code"] == 0,
              f"status={r['status_code']}")
        check(f"{label}: recognized rpc.method={recognized_method}",
              r["attrs"].get("rpc.method") == recognized_method,
              f"rpc.method={r['attrs'].get('rpc.method')}")
        check(f"{label}: recognized span continues injected trace id",
              r["trace_id"] == CARRIER_TRACE_ID, f"trace_id={r['trace_id']}")
        check(f"{label}: recognized span parent IS the injected span id",
              r["parent_span_id"] == CARRIER_SPAN_ID,
              f"parent={r['parent_span_id']}")
        check(f"{label}: recognized span carries jsonrpc.request.id=7",
              r["attrs"].get("jsonrpc.request.id") == "7",
              f"id={r['attrs'].get('jsonrpc.request.id')}")

    # unknown method → _OTHER / ERROR -32601
    unk = [s for s in spans if s["attrs"].get("rpc.method_original") == unknown_method]
    check(f"{label}: unknown {unknown_method!r} → _OTHER + method_original", len(unk) == 1,
          f"originals={[s['attrs'].get('rpc.method_original') for s in spans]}")
    if unk:
        u = unk[0]
        check(f"{label}: unknown span named 'jsonrpc'", u["name"] == "jsonrpc",
              f"name={u['name']}")
        check(f"{label}: unknown rpc.method=_OTHER", u["attrs"].get("rpc.method") == "_OTHER")
        check(f"{label}: unknown span status ERROR(2)", u["status_code"] == 2,
              f"status={u['status_code']}")
        check(f"{label}: unknown status_code/error.type == -32601",
              u["attrs"].get("rpc.response.status_code") == "-32601"
              and u["attrs"].get("error.type") == "-32601",
              f"code={u['attrs'].get('rpc.response.status_code')} "
              f"error.type={u['attrs'].get('error.type')}")
        check(f"{label}: unknown span continues injected trace id",
              u["trace_id"] == CARRIER_TRACE_ID, f"trace_id={u['trace_id']}")

    # unparsable → _OTHER / ERROR -32700 / no original / no id / root
    unp = [
        s
        for s in spans
        if s["name"] == "jsonrpc"
        and s["attrs"].get("rpc.response.status_code") == "-32700"
    ]
    check(f"{label}: unparsable frame → a span exists (was: none at all)", len(unp) == 1,
          f"codes={[s['attrs'].get('rpc.response.status_code') for s in spans]}")
    if unp:
        p = unp[0]
        check(f"{label}: unparsable status ERROR(2)", p["status_code"] == 2)
        check(f"{label}: unparsable has NO rpc.method_original",
              "rpc.method_original" not in p["attrs"])
        check(f"{label}: unparsable has NO jsonrpc.request.id",
              "jsonrpc.request.id" not in p["attrs"])
        check(f"{label}: unparsable is a ROOT (no remote parent)",
              p["parent_span_id"] in ("", "0000000000000000"),
              f"parent={p['parent_span_id']}")

    # PHASE 2: SIGTERM flush — the regression test the review missed.
    sink.reset()
    proc2 = subprocess.Popen(
        [binary, *args],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=env,
    )
    frame = (
        f'{{"jsonrpc":"2.0","id":9,"method":"{unknown_method}",'
        f'"traceparent":"{CARRIER_TP}"}}\n'
    )
    proc2.stdin.write(frame.encode())
    proc2.stdin.flush()
    # Give the helper a moment to answer, THEN SIGTERM with stdin still OPEN so
    # the ONLY route to a flush is the signal handler.
    time.sleep(0.4)
    proc2.send_signal(signal.SIGTERM)
    t0 = time.time()
    try:
        rc = proc2.wait(timeout=4)
    except subprocess.TimeoutExpired:
        proc2.kill()
        rc = None
    elapsed = time.time() - t0
    sigterm_spans = sink.wait_for_spans(1)
    try:
        proc2.stdin.close()
    except Exception:  # noqa: BLE001
        pass
    check(f"{label}: SIGTERM still flushes the buffered span (was: 0)",
          len(sigterm_spans) >= 1, f"got {len(sigterm_spans)} span(s)")
    check(f"{label}: SIGTERM'd helper exits promptly (<3.5s)",
          rc is not None and elapsed < 3.5, f"rc={rc} elapsed={elapsed:.2f}s")

    sink.close()


def main():
    cua = resolve_binary("SYNAPSE_DEVICE_CUA_HELPER_PATH",
                         "sidecars/cua/synapse-device-cua-helper")
    fs = resolve_binary("SYNAPSE_DEVICE_FS_HELPER_PATH",
                        "sidecars/fs-helper/target/release/synapse-device-fs-helper")

    ran_any = False
    if cua:
        ran_any = True
        # cua takes no CLI args; `hello` needs no display access.
        run_helper("cua", cua, [], recognized_method="hello", unknown_method="nope")
    else:
        print("SKIP cua: no synapse-device-cua-helper binary "
              "(SYNAPSE_DEVICE_CUA_HELPER_PATH unset and no repo build)")

    if fs:
        ran_any = True
        work = tempfile.mkdtemp(prefix="pg3-fs-")
        run_helper("fs-helper", fs, ["--root", work, "--work-dir", work],
                   recognized_method="fs.hello", unknown_method="fs.bogus")
    else:
        print("SKIP fs-helper: no synapse-device-fs-helper binary "
              "(SYNAPSE_DEVICE_FS_HELPER_PATH unset and no repo build)")

    if not ran_any:
        print("\nP-G3: both helpers absent (npm install ships none by design — F9c); "
              "nothing to assert. Provide a binary via the container image, a "
              "checkout, or SYNAPSE_DEVICE_{CUA,FS}_HELPER_PATH.")
        return 0

    failed = [n for (n, ok, _) in RESULTS if not ok]
    print(f"\nP-G3: {len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
