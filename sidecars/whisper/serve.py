"""Whisper ASR sidecar — FastAPI over faster-whisper (CTranslate2, CPU).

The Synapse api bundles no ASR engine; it POSTs audio bytes here and gets text.
Wire contract (shared with the sherpa-asr sidecar):

    GET  /healthz    -> {"ok": true, "ready": <bool>, "engine": "whisper", "model": ...}
    POST /transcribe <- {"audio_base64": "...", "mime_type": "audio/ogg"}
                     -> {"text": "...", "model": ..., "language": ...}

ffmpeg (baked into this image) transcodes any container to 16 kHz mono PCM; the
faster-whisper model is a single shared instance, so EVERY decode+inference runs on
a single-thread executor (serialized). A bounded in-flight counter returns 503
(retryable) when saturated. The model is warmed at startup; /healthz reports
ready=false until it loads AND a warm transcription succeeds.
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

log = logging.getLogger("whisper")

MAX_CONCURRENCY = max(1, int(os.environ.get("WHISPER_MAX_CONCURRENCY", "2")))
MAX_AUDIO_BYTES = int(
    os.environ.get("WHISPER_MAX_AUDIO_BYTES", str(25 * 1024 * 1024))
)

# One worker thread: the model is shared + CPU-bound, so warm-up and every
# /transcribe decode+inference share this single thread and thereby serialize.
_executor = ThreadPoolExecutor(max_workers=1)
_model = None
_ready = False
_init_error: str | None = None

_inflight = 0
_inflight_lock = asyncio.Lock()


def _init_model():
    import numpy as np

    from pipeline import build_model

    model = build_model(local_files_only=True)
    # Exercise the pipeline with 0.5 s of silence so a broken model/runtime raises
    # HERE (not on the first real request); readiness reflects a usable engine.
    transcribe(model, np.zeros(8000, dtype=np.float32))
    return model


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _model, _ready, _init_error
    loop = asyncio.get_running_loop()
    try:
        _model = await loop.run_in_executor(_executor, _init_model)
        _ready = True
    except Exception as exc:  # noqa: BLE001
        # Don't crash-loop: stay up but unhealthy (ready=false) so the failure is
        # visible via /healthz + the compose healthcheck, and log it loudly.
        _init_error = f"{type(exc).__name__}: {exc}"
        log.error(
            "whisper model initialization failed: %s", _init_error, exc_info=True
        )
    yield


app = FastAPI(title="synapse-whisper", lifespan=lifespan)
tracing.setup_tracing("whisper")
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
    return transcribe(_model, samples)


@app.get("/healthz")
def healthz() -> dict:
    body = {"ok": True, "ready": _ready, "engine": "whisper", "model": MODEL_LABEL}
    if _init_error:
        body["error"] = _init_error
    return body


@app.post("/transcribe")
async def transcribe_endpoint(req: TranscribeRequest):
    if not _ready:
        return JSONResponse(
            status_code=503, content={"error": "whisper model is not ready"}
        )
    if not await _try_acquire():
        return JSONResponse(
            status_code=503, content={"error": "whisper sidecar is busy"}
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
                status_code=500, content={"error": f"whisper failed: {exc}"}
            )

        result["model"] = MODEL_LABEL
        return result
    finally:
        await _release()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("WHISPER_HOST", "0.0.0.0"),
        port=int(os.environ.get("WHISPER_PORT", "8773")),
    )
