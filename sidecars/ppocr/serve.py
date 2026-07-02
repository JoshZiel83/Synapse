"""PP-OCRv6 OCR sidecar — FastAPI over the official paddleocr pipeline (CPU).

The Synapse api bundles no OCR engine; it POSTs image bytes here and gets text.
Wire contract (shared with the tesseract sidecar):

    GET  /healthz -> {"ok": true, "ready": <bool>, "engine": "ppocr", "tier": ..., "model": ...}
    POST /ocr     <- {"image_base64": "...", "mime_type": "image/png"}
                  -> {"text": "...", "lines": [...], "model": ..., "pages": 1, "image": {"w":..,"h":..}}

A single PaddleOCR instance is NOT thread-safe (PaddleOCR #16238), so EVERY
predict runs on a single-thread executor (serialized). A bounded in-flight
counter returns 503 (retryable) when saturated. The model is warmed at startup;
/healthz reports ready=false until the pipeline is built AND a warm predict
succeeds, so "ready" means a usable engine (a broken model set stays unhealthy
rather than reporting healthy-but-500ing).
"""

import asyncio
import base64
import binascii
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

import cv2  # provided transitively by paddleocr's opencv dependency
import numpy as np
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from pipeline import MODEL_LABEL, TIER, build_pipeline, extract_result

log = logging.getLogger("ppocr")

MAX_CONCURRENCY = max(1, int(os.environ.get("PPOCR_MAX_CONCURRENCY", "2")))
MAX_IMAGE_BYTES = int(os.environ.get("PPOCR_MAX_IMAGE_BYTES", str(20 * 1024 * 1024)))

# One worker thread: the PaddleOCR instance is not thread-safe, so warm-up and
# every /ocr predict share this single thread and thereby serialize.
_executor = ThreadPoolExecutor(max_workers=1)
_pipeline = None
_ready = False
_init_error: str | None = None

_inflight = 0
_inflight_lock = asyncio.Lock()


class DecodeError(ValueError):
    """The uploaded bytes are not a decodable image — a TERMINAL (non-retryable)
    condition, distinct from an engine failure."""


def _init_pipeline():
    pipe = build_pipeline(TIER)
    # Exercise the lazily-initialized predictor with a dummy image. If the model
    # set is broken this raises HERE (not silently on the first real request),
    # so readiness reflects a genuinely usable pipeline.
    warm = np.full((32, 64, 3), 255, dtype=np.uint8)
    pipe.predict(warm)
    return pipe


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _pipeline, _ready, _init_error
    loop = asyncio.get_running_loop()
    try:
        _pipeline = await loop.run_in_executor(_executor, _init_pipeline)
        _ready = True
    except Exception as exc:  # noqa: BLE001
        # Don't crash-loop: stay up but unhealthy (ready=false) so the failure is
        # visible via /healthz + the compose healthcheck, and log it loudly.
        _init_error = f"{type(exc).__name__}: {exc}"
        log.error("ppocr pipeline initialization failed: %s", _init_error, exc_info=True)
    yield


app = FastAPI(title="synapse-ppocr", lifespan=lifespan)


class OcrRequest(BaseModel):
    image_base64: str
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


def _run(image_bytes: bytes) -> dict:
    # PaddleOCR expects a BGR numpy array (cv2 decodes to BGR).
    arr = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
    if arr is None:
        raise DecodeError("could not decode image bytes")
    height, width = arr.shape[:2]
    extracted = extract_result(_pipeline.predict(arr))
    extracted["image"] = {"w": int(width), "h": int(height)}
    return extracted


@app.get("/healthz")
def healthz() -> dict:
    body = {
        "ok": True,
        "ready": _ready,
        "engine": "ppocr",
        "tier": TIER,
        "model": MODEL_LABEL,
    }
    if _init_error:
        body["error"] = _init_error
    return body


@app.post("/ocr")
async def ocr(req: OcrRequest):
    if not _ready:
        return JSONResponse(
            status_code=503, content={"error": "ppocr model is not ready"}
        )
    if not await _try_acquire():
        return JSONResponse(status_code=503, content={"error": "ppocr sidecar is busy"})
    try:
        try:
            image_bytes = base64.b64decode(req.image_base64, validate=True)
        except (binascii.Error, ValueError):
            return JSONResponse(
                status_code=400, content={"error": "invalid base64 image payload"}
            )
        if not image_bytes:
            return JSONResponse(status_code=400, content={"error": "empty image payload"})
        if len(image_bytes) > MAX_IMAGE_BYTES:
            return JSONResponse(
                status_code=413, content={"error": "image exceeds size limit"}
            )

        loop = asyncio.get_running_loop()
        try:
            result = await loop.run_in_executor(_executor, _run, image_bytes)
        except DecodeError as exc:
            # Undecodable image = terminal (4xx), so the api won't retry it.
            return JSONResponse(status_code=400, content={"error": str(exc)})
        except Exception as exc:  # noqa: BLE001 — engine error = retryable (5xx)
            return JSONResponse(
                status_code=500, content={"error": f"ppocr failed: {exc}"}
            )

        result["model"] = MODEL_LABEL
        result["pages"] = 1
        return result
    finally:
        await _release()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("PPOCR_HOST", "0.0.0.0"),
        port=int(os.environ.get("PPOCR_PORT", "8770")),
    )
