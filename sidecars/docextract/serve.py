"""Document-extraction sidecar — a small FastAPI shim over Apache Tika Server.

The Synapse api bundles NO document-parsing engine (zero-engine-api, the 5th
sibling of the OCR / embedding / transcription / realtime-ASR provider
abstractions). It POSTs document bytes (PDF + office + epub) to this sidecar and
receives extracted plaintext + minimal structure. Wire contract (shared shape
with the other FastAPI sidecars):

    GET  /healthz -> {"ok": true, "ready": true, "engine": "tika", "version": "..."}
    POST /extract <- {"content_base64": "...", "mime_type": "application/pdf",
                      "filename": "doc.pdf"}
                  -> {"text": "...", "text_format": "plaintext",
                      "structured": {"schemaVersion": 1, "pageCount": 3,
                                     "contentType": "application/pdf"},
                      "engine": "tika", "version": "..."}

Why a shim over Tika's own HTTP API: it gives the api ONE uniform base64-JSON +
/healthz + status-discipline contract (identical to tesseract/ppocr/whisper), so
the api adapter reuses the shared sidecar factory unchanged, and it lets us map
Tika's behaviour onto the never-reject retry classification the parse pipeline
needs.

Status discipline (the "free correctness win" — encrypted/corrupt docs must be
TERMINAL, not a 3-attempt retry storm):
    200  extraction ran (INCLUDING empty text — a scanned/text-layerless PDF is a
         SUCCESS carrying page metadata, NOT a failure)
    400  malformed request (bad/empty base64)
    413  payload exceeds the size cap
    422  DETERMINISTIC engine failure (encrypted / corrupt / unsupported format)
         -> the api treats it as terminal (no retry)
    503  the shim's bounded pool is saturated OR Tika is still warming OR Tika is
         down (transient) -> the api retries
"""

import asyncio
import base64
import binascii
import contextvars
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# `_shared` import bootstrap: the image flat-COPYs sidecars/_shared/ next to
# this file (importable via the /app script dir); in the repo it lives one
# level up (sidecars/_shared), so put sidecars/ on sys.path there.
if not (Path(__file__).resolve().parent / "_shared").is_dir():
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from _shared import tracing

# --- config (env) -----------------------------------------------------------
TIKA_JAR = os.environ.get("TIKA_JAR", "/opt/tika/tika-server.jar")
TIKA_VERSION = os.environ.get("TIKA_VERSION", "unknown")
TIKA_INTERNAL_HOST = "127.0.0.1"
TIKA_INTERNAL_PORT = int(os.environ.get("TIKA_INTERNAL_PORT", "9998"))
TIKA_BASE = f"http://{TIKA_INTERNAL_HOST}:{TIKA_INTERNAL_PORT}"
JAVA_OPTS = os.environ.get("DOCEXTRACT_JAVA_OPTS", "-Xmx1024m")
# Always make an OOM actually KILL the JVM (so the supervisor respawns it) instead
# of leaving it wedged — appended regardless of the configured opts.
_JVM_ARGS = [*JAVA_OPTS.split(), "-XX:+ExitOnOutOfMemoryError"]
MAX_CONCURRENCY = max(1, int(os.environ.get("DOCEXTRACT_MAX_CONCURRENCY", "2")))
MAX_BYTES = int(os.environ.get("DOCEXTRACT_MAX_BYTES", str(40 * 1024 * 1024)))
# Per-request budget for the internal Tika call (seconds).
TIKA_CALL_TIMEOUT = float(os.environ.get("DOCEXTRACT_TIKA_TIMEOUT_S", "55"))

# Tika 5xx bodies that indicate a TRANSIENT fault (retry may help) rather than a
# deterministic bad-document fault. Everything else at 5xx is treated as a
# deterministic parse failure (terminal) so a corrupt file can't retry-storm.
_TRANSIENT_MARKERS = ("OutOfMemoryError", "timed out", "timeout", "GC overhead")

_executor = ThreadPoolExecutor(max_workers=MAX_CONCURRENCY)
_tika_proc: subprocess.Popen | None = None
_ready = False

# Non-blocking concurrency gate: reject (503) rather than queue past the cap so a
# burst of parses can't pile onto one container and blow every request's timeout.
_inflight = 0
_inflight_lock = asyncio.Lock()


class ExtractRequest(BaseModel):
    content_base64: str
    mime_type: str | None = None
    filename: str | None = None
    # "text" (plaintext, /rmeta/text) or "markdown" (Tika XHTML via /rmeta/html →
    # markdown, preserving headings/lists/tables). The api's `local` provider picks
    # this from DOCEXTRACT_OUTPUT_FORMAT — the Phase-2 rich/markdown tier.
    output_format: str = "text"


async def _try_acquire() -> bool:
    global _inflight
    async with _inflight_lock:
        if _inflight >= MAX_CONCURRENCY:
            return False
        _inflight += 1
        return True


async def _release() -> None:
    global _inflight
    async with _inflight_lock:
        _inflight -= 1


def _tika_up() -> bool:
    """True when the internal Tika Server answers its liveness endpoint."""
    try:
        with urllib.request.urlopen(f"{TIKA_BASE}/tika", timeout=3) as resp:
            return resp.status == 200
    except Exception:
        return False


def _start_tika() -> subprocess.Popen:
    cmd = ["java", *_JVM_ARGS, "-jar", TIKA_JAR,
           "--host", TIKA_INTERNAL_HOST, "--port", str(TIKA_INTERNAL_PORT)]
    # Inherit stdio so Tika's log lands in the container log stream.
    return subprocess.Popen(cmd)


async def _supervise() -> None:
    """Keep the Tika JVM alive AND keep `_ready` accurate. Every cycle: (re)spawn
    Tika if it is missing/dead, then set `_ready` from a LIVE liveness probe. So a
    crashed/OOM-killed JVM flips `_ready` → False within one cycle (the container
    healthcheck then marks the sidecar unhealthy) AND is respawned in-process — the
    sidecar self-heals without needing a full container restart. This replaces the
    old fire-once warm task, whose latched `_ready=True` left a dead Tika reporting
    healthy forever."""
    global _tika_proc, _ready
    loop = asyncio.get_running_loop()
    while True:
        if _tika_proc is None or _tika_proc.poll() is not None:
            if _tika_proc is not None:
                _ready = False
                print(
                    f"tika process exited (code={_tika_proc.returncode}); respawning",
                    flush=True,
                )
            _tika_proc = _start_tika()
        _ready = await loop.run_in_executor(_executor, _tika_up)
        await asyncio.sleep(2.0)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    supervisor = asyncio.create_task(_supervise())
    try:
        yield
    finally:
        supervisor.cancel()
        if _tika_proc and _tika_proc.poll() is None:
            _tika_proc.terminate()
            try:
                _tika_proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                _tika_proc.kill()


app = FastAPI(title="synapse-docextract", lifespan=lifespan)
tracing.setup_tracing("docextract")
tracing.instrument_app(app)


def _tika_extract(
    content: bytes, mime_type: str | None, filename: str | None, output_format: str
):
    """Blocking call to the internal Tika Server /rmeta (returns content + metadata
    in one round-trip). Runs in the thread pool. For markdown the XHTML variant
    (/rmeta/html) is requested and converted; for text the plaintext variant.

    Returns (status_code, payload) where status_code is the code THIS shim should
    return to the api and payload is the JSON body.
    """
    want_markdown = output_format == "markdown"
    tika_path = "/rmeta/html" if want_markdown else "/rmeta/text"
    headers = {"Accept": "application/json"}
    if mime_type:
        headers["Content-Type"] = mime_type
    if filename:
        # Extension hint improves Tika's container/type detection.
        headers["Content-Disposition"] = f'attachment; filename="{filename}"'
    url = f"{TIKA_BASE}{tika_path}"
    # Manual CLIENT span for the in-container Tika hop (§4.E change 5): records
    # hop latency/status and injects a traceparent into the headers (inert to
    # the uninstrumented Tika JVM, but future-proof). The supervisor's 2s
    # _tika_up() liveness probe stays deliberately untraced. Exceptions are
    # CAUGHT inside the block, so each branch reports the outcome explicitly.
    with tracing.client_span(
        "PUT", url, inject_into=headers, name=f"PUT {tika_path}"
    ) as span:
        req = urllib.request.Request(url, data=content, headers=headers, method="PUT")
        try:
            with urllib.request.urlopen(req, timeout=TIKA_CALL_TIMEOUT) as resp:
                tracing.set_client_response(span, resp.status)
                body = resp.read().decode("utf-8", errors="replace")
                return _map_tika_success(resp.status, body, want_markdown)
        except urllib.error.HTTPError as exc:
            tracing.set_client_response(span, exc.code)
            body = ""
            try:
                body = exc.read().decode("utf-8", errors="replace")
            except Exception:
                pass
            if exc.code < 500:
                # 4xx from Tika = deterministic (unsupported / malformed) -> terminal.
                return 422, {"error": f"tika rejected the document (HTTP {exc.code})"}
            if any(m.lower() in body.lower() for m in _TRANSIENT_MARKERS):
                return 503, {"error": "tika transient fault (retryable)"}
            # 5xx without a transient marker = this document broke this parser ->
            # deterministic, terminal (retrying the same bytes cannot help).
            return 422, {"error": "tika could not parse the document"}
        except TimeoutError as exc:
            tracing.set_client_error(span, exc)
            # The parse exceeded the per-document time budget. That is deterministic for
            # THESE bytes (too large/complex to parse in the budget), so terminal — NOT
            # retryable, or the api would retry the same slow doc up to 3× at ~55s each,
            # each attempt holding a concurrency slot (the storm the budget prevents).
            return 422, {"error": "tika parse exceeded the time budget"}
        except (urllib.error.URLError, ConnectionError, OSError) as exc:
            tracing.set_client_error(span, exc)
            # Tika process down / connection refused -> transient, retryable.
            return 503, {"error": "tika is unavailable (retryable)"}


def _html_to_markdown(html: str) -> str:
    """Convert Tika's XHTML body to markdown (headings/lists/tables preserved)."""
    if not html.strip():
        return ""
    from markdownify import markdownify

    return markdownify(html, heading_style="ATX").strip()


def _map_tika_success(status: int, body: str, want_markdown: bool):
    try:
        docs = json.loads(body)
    except (ValueError, TypeError):
        return 422, {"error": "tika returned an unparseable response"}
    # /rmeta returns a JSON array (one entry per embedded doc); [0] is the root.
    root = docs[0] if isinstance(docs, list) and docs else {}
    if not isinstance(root, dict):
        root = {}
    text = root.get("X-TIKA:content") or ""
    if not isinstance(text, str):
        text = ""
    if want_markdown:
        try:
            text = _html_to_markdown(text)
        except Exception:  # noqa: BLE001 — markdownify/bs4 can throw on odd html
            # Deterministic for these bytes → terminal 422, NOT a 500 the api would
            # classify retryable and retry-storm.
            return 422, {"error": "tika markdown conversion failed"}
        text_format = "markdown"
    else:
        text_format = "plaintext"
    page_count = _first_int(
        root.get("xmpTPg:NPages"), root.get("meta:page-count"),
        root.get("Page-Count"), root.get("meta:slide-count"),
    )
    structured = {"schemaVersion": 1}
    if page_count is not None:
        structured["pageCount"] = page_count
    content_type = root.get("Content-Type")
    if isinstance(content_type, str) and content_type:
        # Tika may append "; charset=..."; keep the base type.
        structured["contentType"] = content_type.split(";", 1)[0].strip()
    return status, {
        "text": text,
        "text_format": text_format,
        "structured": structured,
        "engine": "tika",
        "version": TIKA_VERSION,
    }


def _first_int(*values) -> int | None:
    for value in values:
        if value is None:
            continue
        try:
            return int(str(value).strip())
        except (ValueError, TypeError):
            continue
    return None


@app.get("/healthz")
def healthz() -> dict:
    # Reflect LIVE Tika state, not just the latched warm flag: if the JVM child has
    # exited, report not-ready immediately (don't wait for the next supervise cycle)
    # so the container healthcheck can act on a just-crashed engine.
    alive = _tika_proc is not None and _tika_proc.poll() is None
    return {
        "ok": True,
        "ready": _ready and alive,
        "engine": "tika",
        "version": TIKA_VERSION,
    }


@app.post("/extract")
async def extract(req: ExtractRequest):
    if not _ready:
        return JSONResponse(
            status_code=503,
            content={"error": "docextract sidecar is still warming (tika starting)"},
        )
    if not await _try_acquire():
        return JSONResponse(
            status_code=503, content={"error": "docextract sidecar is busy"}
        )
    try:
        try:
            content = base64.b64decode(req.content_base64, validate=True)
        except (binascii.Error, ValueError):
            return JSONResponse(
                status_code=400, content={"error": "invalid base64 document payload"}
            )
        if not content:
            return JSONResponse(
                status_code=400, content={"error": "empty document payload"}
            )
        if len(content) > MAX_BYTES:
            return JSONResponse(
                status_code=413, content={"error": "document exceeds size limit"}
            )

        loop = asyncio.get_running_loop()
        # copy_context().run is REQUIRED for the OTel context (this request's
        # SERVER span) to reach the worker thread — a naked run_in_executor
        # drops it and the Tika CLIENT span would be parentless (spike-proven).
        ctx = contextvars.copy_context()
        status, payload = await loop.run_in_executor(
            _executor,
            lambda: ctx.run(
                _tika_extract,
                content,
                req.mime_type,
                req.filename,
                req.output_format,
            ),
        )
        if status == 200:
            return payload
        return JSONResponse(status_code=status, content=payload)
    finally:
        await _release()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("DOCEXTRACT_HOST", "0.0.0.0"),
        port=int(os.environ.get("DOCEXTRACT_PORT", "8776")),
    )
