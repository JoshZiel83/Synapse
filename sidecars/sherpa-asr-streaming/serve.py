"""sherpa-onnx STREAMING ASR sidecar — FastAPI over a WebSocket (CPU).

The realtime analogue of the batch sidecars/sherpa-asr/serve.py. The Synapse api's
realtime /ws/asr sherpa-stream provider connects here and streams raw 16 kHz mono
s16le PCM; this sidecar streams back partial/final/completed JSON.

Wire contract (we own both ends — see the sherpa-stream adapter):
    GET  /healthz -> {"ok": true, "ready": <bool>, "engine": "sherpa-asr-streaming", "model": ...}
    WS   /ws
        client -> text  {"type": "start", "sampleRate": 16000}   (optional, ignored)
               -> binary <16 kHz mono s16le PCM frames>
               -> text  {"type": "stop"}
        server -> text  {"type": "partial", "displayText": ..., "unstableText": ...}
               -> text  {"type": "final", "text": ..., "segmentIndex": N}
               -> text  {"type": "completed", "text": ...}
               -> text  {"type": "error", "message": ...}

The OnlineRecognizer is a single shared instance; every decode runs on a single-thread
executor (serialized, since the recognizer is not assumed thread-safe). A bounded
in-flight counter rejects new WebSocket sessions with an error+close when saturated.
The model is warmed at startup; /healthz reports ready=false until it loads AND a warm
decode succeeds, so a broken model set stays unhealthy rather than erroring every
connection.
"""

import asyncio
import json
import logging
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from pipeline import MODEL_LABEL, StreamSession, pcm_s16le_to_float32

# `_shared` import bootstrap: the image flat-COPYs sidecars/_shared/ next to
# this file (importable via the /app script dir); in the repo it lives one
# level up (sidecars/_shared), so put sidecars/ on sys.path there.
if not (Path(__file__).resolve().parent / "_shared").is_dir():
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from _shared import tracing

log = logging.getLogger("sherpa-asr-streaming")

MAX_CONCURRENCY = max(1, int(os.environ.get("SHERPA_STREAM_MAX_CONCURRENCY", "4")))

# One worker thread: the recognizer is shared + not assumed thread-safe, so warm-up
# and every decode share this single thread and thereby serialize.
_executor = ThreadPoolExecutor(max_workers=1)
_recognizer = None
_ready = False
_init_error: str | None = None

_inflight = 0
_inflight_lock = asyncio.Lock()


def _init_recognizer():
    import numpy as np

    from pipeline import build_recognizer

    recognizer = build_recognizer()
    # Exercise the streaming pipeline with 0.5 s of silence so a broken
    # model/onnxruntime raises HERE (not on the first real connection).
    warm = StreamSession(recognizer)
    warm.accept_audio(np.zeros(8000, dtype=np.float32))
    warm.finish()
    return recognizer


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _recognizer, _ready, _init_error
    loop = asyncio.get_running_loop()
    try:
        _recognizer = await loop.run_in_executor(_executor, _init_recognizer)
        _ready = True
    except Exception as exc:  # noqa: BLE001
        # Don't crash-loop: stay up but unhealthy (ready=false) so the failure is
        # visible via /healthz + the compose healthcheck, and log it loudly.
        _init_error = f"{type(exc).__name__}: {exc}"
        log.error(
            "sherpa-asr-streaming recognizer initialization failed: %s",
            _init_error,
            exc_info=True,
        )
    yield


app = FastAPI(title="synapse-sherpa-asr-streaming", lifespan=lifespan)
# exclude_spans=["receive","send"] makes one WS connection exactly ONE SERVER
# span (== one dictation session), parented on the handshake traceparent the
# api's HttpInstrumentation injects into the upgrade request (§4.E change 4).
tracing.setup_tracing("sherpa-asr-streaming")
tracing.instrument_app(app)


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
        if _inflight > 0:
            _inflight -= 1


@app.get("/healthz")
def healthz() -> dict:
    body = {
        "ok": True,
        "ready": _ready,
        "engine": "sherpa-asr-streaming",
        "model": MODEL_LABEL,
    }
    if _init_error:
        body["error"] = _init_error
    return body


async def _send(ws: WebSocket, messages) -> None:
    for message in messages:
        await ws.send_text(json.dumps(message))


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    # The ONE SERVER span the instrumentor opened for this connection (None
    # when tracing is disabled) — enriched with session counters; NO per-frame
    # or per-utterance sidecar spans (decodes serialize on the shared
    # single-thread executor; utterance granularity is api-side).
    span = tracing.current_span()
    await ws.accept()

    if not _ready:
        # Transient: the model is still warming up. retryable=true so the client
        # reconnects rather than treating dictation as permanently unavailable.
        if span is not None:
            span.set_attribute("synapse.asr.rejected", "warming")
        await ws.send_text(
            json.dumps(
                {
                    "type": "error",
                    "message": "sherpa-stream model is not ready",
                    "retryable": True,
                }
            )
        )
        await ws.close()
        return

    if not await _try_acquire():
        # Transient: at capacity. retryable=true so the client backs off + retries.
        if span is not None:
            span.set_attribute("synapse.asr.rejected", "busy")
        await ws.send_text(
            json.dumps(
                {
                    "type": "error",
                    "message": "sherpa-stream sidecar is busy",
                    "retryable": True,
                }
            )
        )
        await ws.close()
        return

    pcm_bytes = 0
    segments = 0
    completed = False
    try:
        # Construct the session INSIDE the try so a create_stream() failure still
        # releases the acquired in-flight slot (finally: _release) — otherwise the
        # slot leaks and, after MAX_CONCURRENCY such failures, the sidecar wedges.
        session = StreamSession(_recognizer)
        loop = asyncio.get_running_loop()
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                break

            data = message.get("bytes")
            if data is not None:
                pcm_bytes += len(data)
                samples = pcm_s16le_to_float32(data)
                if samples.size == 0:
                    continue
                out = await loop.run_in_executor(
                    _executor, session.accept_audio, samples
                )
                segments += sum(1 for m in out if m.get("type") == "final")
                await _send(ws, out)
                continue

            text = message.get("text")
            if text is None:
                continue
            try:
                control = json.loads(text)
            except (json.JSONDecodeError, ValueError):
                continue
            if control.get("type") == "stop":
                out = await loop.run_in_executor(_executor, session.finish)
                segments += sum(1 for m in out if m.get("type") == "final")
                completed = any(m.get("type") == "completed" for m in out)
                await _send(ws, out)
                await ws.close()
                break
            # "start" and any unknown control frame are ignored.
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001
        log.warning("sherpa-asr-streaming session failed: %s", exc, exc_info=True)
        try:
            await ws.send_text(
                json.dumps({"type": "error", "message": f"sherpa-stream failed: {exc}"})
            )
            await ws.close()
        except Exception:  # noqa: BLE001
            pass
    finally:
        if span is not None:
            span.set_attribute("synapse.asr.pcm_bytes", pcm_bytes)
            span.set_attribute("synapse.asr.segments", segments)
            span.set_attribute("synapse.asr.completed", completed)
        await _release()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("SHERPA_STREAM_HOST", "0.0.0.0"),
        port=int(os.environ.get("SHERPA_STREAM_PORT", "8774")),
    )
