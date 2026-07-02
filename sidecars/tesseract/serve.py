"""Tesseract OCR sidecar — a small FastAPI service wrapping native tesseract-ocr.

The Synapse api bundles no OCR engine (zero-OCR-api). It POSTs image bytes to
this sidecar and receives extracted text. Wire contract (shared with the ppocr
sidecar):

    GET  /healthz -> {"ok": true, "ready": true, "engine": "tesseract", "langs": ...}
    POST /ocr     <- {"image_base64": "...", "mime_type": "image/png", "langs": "eng"}
                  -> {"text": "...", "engine": "tesseract", "langs": "eng"}

Backpressure: a bounded in-flight counter (TESSERACT_MAX_CONCURRENCY) returns
HTTP 503 when saturated, which the api maps to a retryable failure — so a burst
of parses can't pile onto one CPU container and blow every request's timeout.
"""

import asyncio
import base64
import binascii
import io
import os
from concurrent.futures import ThreadPoolExecutor

import pytesseract
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from PIL import Image
from pydantic import BaseModel

DEFAULT_LANGS = os.environ.get("TESSERACT_DEFAULT_LANGS", "eng").strip() or "eng"
TESSDATA_DIR = os.environ.get("TESSDATA_DIR", "").strip()
MAX_CONCURRENCY = max(1, int(os.environ.get("TESSERACT_MAX_CONCURRENCY", "2")))
MAX_IMAGE_BYTES = int(
    os.environ.get("TESSERACT_MAX_IMAGE_BYTES", str(20 * 1024 * 1024))
)

app = FastAPI(title="synapse-tesseract-ocr")
_executor = ThreadPoolExecutor(max_workers=MAX_CONCURRENCY)

# Non-blocking concurrency gate: reject (503) rather than queue past the cap.
_inflight = 0
_inflight_lock = asyncio.Lock()


class OcrRequest(BaseModel):
    image_base64: str
    mime_type: str | None = None
    langs: str | None = None


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


def run_ocr(image_bytes: bytes, langs: str) -> str:
    """Blocking OCR — runs in the thread pool. Normalizes arbitrary input formats
    to RGB (PIL) the way the old in-api `sharp` step did before tesseract."""
    with Image.open(io.BytesIO(image_bytes)) as img:
        rgb = img.convert("RGB")
        config = f"--tessdata-dir {TESSDATA_DIR}" if TESSDATA_DIR else ""
        return pytesseract.image_to_string(rgb, lang=langs, config=config)


@app.get("/healthz")
def healthz() -> dict:
    # tesseract has no model to warm, so it is ready as soon as the process is up.
    return {"ok": True, "ready": True, "engine": "tesseract", "langs": DEFAULT_LANGS}


@app.post("/ocr")
async def ocr(req: OcrRequest):
    if not await _try_acquire():
        return JSONResponse(
            status_code=503, content={"error": "tesseract OCR sidecar is busy"}
        )
    try:
        try:
            image_bytes = base64.b64decode(req.image_base64, validate=True)
        except (binascii.Error, ValueError):
            return JSONResponse(
                status_code=400, content={"error": "invalid base64 image payload"}
            )
        if not image_bytes:
            return JSONResponse(
                status_code=400, content={"error": "empty image payload"}
            )
        if len(image_bytes) > MAX_IMAGE_BYTES:
            return JSONResponse(
                status_code=413, content={"error": "image exceeds size limit"}
            )

        langs = (req.langs or DEFAULT_LANGS).strip() or DEFAULT_LANGS
        loop = asyncio.get_running_loop()
        try:
            text = await loop.run_in_executor(
                _executor, run_ocr, image_bytes, langs
            )
        except Exception as exc:  # noqa: BLE001 — surface the engine error to the api
            return JSONResponse(
                status_code=500, content={"error": f"tesseract OCR failed: {exc}"}
            )

        return {"text": text or "", "engine": "tesseract", "langs": langs}
    finally:
        await _release()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("TESSERACT_HOST", "0.0.0.0"),
        port=int(os.environ.get("TESSERACT_PORT", "8771")),
    )
