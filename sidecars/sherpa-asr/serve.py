"""sherpa-onnx SenseVoice ASR sidecar — FastAPI over an offline recognizer (CPU).

The Synapse api bundles no ASR engine; it POSTs audio bytes here and gets text.
Wire contract:

    GET  /healthz    -> {"ok": true, "ready": <bool>, "engine": "sherpa-asr", "model": ...}
    POST /transcribe <- {"audio_base64": "...", "mime_type": "audio/ogg"}
                     -> {"text": "...", "model": ..., "language": ...}

ffmpeg (baked into this image) transcodes any input container to 16 kHz mono PCM;
the sherpa-onnx recognizer is a single shared instance, so EVERY decode runs on a
single-thread executor (serialized). A bounded in-flight counter returns 503
(retryable) when saturated. The model is warmed at startup; /healthz reports
ready=false until the recognizer loads AND a warm decode succeeds, so a broken
model set stays unhealthy rather than 500ing every request.
"""

import asyncio
import base64
import binascii
import logging
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from pipeline import MODEL_LABEL, DecodeError, decode_to_pcm, transcribe

# `_shared` import bootstrap: the image flat-COPYs sidecars/_shared/ next to
# this file (importable via the /app script dir); in the repo it lives one
# level up (sidecars/_shared), so put sidecars/ on sys.path there.
if not (Path(__file__).resolve().parent / "_shared").is_dir():
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from _shared import tracing

log = logging.getLogger("sherpa-asr")

MAX_CONCURRENCY = max(1, int(os.environ.get("SHERPA_ASR_MAX_CONCURRENCY", "2")))
MAX_AUDIO_BYTES = int(
    os.environ.get("SHERPA_ASR_MAX_AUDIO_BYTES", str(25 * 1024 * 1024))
)

# One worker thread: the recognizer is shared + not assumed thread-safe, so warm-up
# and every /transcribe decode share this single thread and thereby serialize.
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
    # Exercise the pipeline with 0.5 s of silence so a broken model/onnxruntime
    # raises HERE (not on the first real request); readiness reflects a usable
    # engine.
    transcribe(recognizer, np.zeros(8000, dtype=np.float32))
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
            "sherpa-asr recognizer initialization failed: %s",
            _init_error,
            exc_info=True,
        )
    yield


app = FastAPI(title="synapse-sherpa-asr", lifespan=lifespan)
tracing.setup_tracing("sherpa-asr")
tracing.instrument_app(app)


class TranscribeRequest(BaseModel):
    audio_base64: str
    mime_type: str | None = None


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


def _run(audio_bytes: bytes) -> dict:
    samples = decode_to_pcm(audio_bytes)
    return transcribe(_recognizer, samples)


@app.get("/healthz")
def healthz() -> dict:
    body = {
        "ok": True,
        "ready": _ready,
        "engine": "sherpa-asr",
        "model": MODEL_LABEL,
    }
    if _init_error:
        body["error"] = _init_error
    return body


@app.post("/transcribe")
async def transcribe_endpoint(req: TranscribeRequest):
    if not _ready:
        return JSONResponse(
            status_code=503, content={"error": "sherpa-asr model is not ready"}
        )
    if not await _try_acquire():
        return JSONResponse(
            status_code=503, content={"error": "sherpa-asr sidecar is busy"}
        )
    try:
        try:
            audio_bytes = base64.b64decode(req.audio_base64, validate=True)
        except (binascii.Error, ValueError):
            return JSONResponse(
                status_code=400, content={"error": "invalid base64 audio payload"}
            )
        if not audio_bytes:
            return JSONResponse(
                status_code=400, content={"error": "empty audio payload"}
            )
        if len(audio_bytes) > MAX_AUDIO_BYTES:
            return JSONResponse(
                status_code=413, content={"error": "audio exceeds size limit"}
            )

        loop = asyncio.get_running_loop()
        try:
            result = await loop.run_in_executor(_executor, _run, audio_bytes)
        except DecodeError as exc:
            # Undecodable audio = terminal (4xx), so the api won't retry it.
            return JSONResponse(status_code=400, content={"error": str(exc)})
        except Exception as exc:  # noqa: BLE001 — engine error = retryable (5xx)
            return JSONResponse(
                status_code=500, content={"error": f"sherpa-asr failed: {exc}"}
            )

        result["model"] = MODEL_LABEL
        return result
    finally:
        await _release()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("SHERPA_ASR_HOST", "0.0.0.0"),
        port=int(os.environ.get("SHERPA_ASR_PORT", "8772")),
    )
