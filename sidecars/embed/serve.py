"""Embedding sidecar — FastAPI over onnxruntime + tokenizers (BAAI/bge-m3 dense,
CPU, no torch).

The Synapse api bundles no embedding engine; it POSTs texts here and gets back
dense 1024-d L2-normalized vectors. Wire contract (the `local` provider in
modules/embedding/providers/local.ts):

    GET  /healthz  -> {"ok": true, "ready": <bool>, "engine": "bge-m3",
                       "model": "bge-m3", "dim": 1024}
    POST /embed    <- {"texts": ["..."], "input_type": "query"|"passage"|null}
                   -> {"embeddings": [[...], ...], "dim": 1024, "model": "bge-m3"}

input_type is accepted for api-interface parity but bge-m3 is symmetric (no
query/passage instruction), so it does not change the output. The model is a
single shared instance, so every embed runs on a single-thread executor
(serialized); a bounded in-flight counter returns 503 (retryable) when saturated.
The model is warmed at startup; /healthz reports ready=false until it loads AND a
warm embed succeeds.
"""

import asyncio
import logging
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from pipeline import EMBED_DIM, MODEL_LABEL, EmbedError, build_model, embed_texts

# `_shared` import bootstrap: the image flat-COPYs sidecars/_shared/ next to
# this file (importable via the /app script dir); in the repo it lives one
# level up (sidecars/_shared), so put sidecars/ on sys.path there.
if not (Path(__file__).resolve().parent / "_shared").is_dir():
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from _shared import tracing

log = logging.getLogger("embed")

MAX_CONCURRENCY = max(1, int(os.environ.get("EMBED_MAX_CONCURRENCY", "2")))
# Cap texts per request. The api batches by EMBEDDING_BATCH_SIZE (default 12); a
# far higher ceiling here just guards a pathological caller from OOMing the
# single-thread model.
MAX_TEXTS = int(os.environ.get("EMBED_MAX_TEXTS", "128"))

_executor = ThreadPoolExecutor(max_workers=1)
_model = None
_ready = False
_init_error: str | None = None

_inflight = 0
_inflight_lock = asyncio.Lock()


def _init_model():
    model = build_model(local_files_only=True)
    # Exercise the graph so a broken model/runtime raises HERE (not on the first
    # real request); readiness reflects a usable engine emitting the right width.
    vectors = embed_texts(model, ["warmup"])
    if vectors.shape != (1, EMBED_DIM):
        raise EmbedError(
            f"warmup produced shape {vectors.shape}, expected (1, {EMBED_DIM})"
        )
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
            "embedding model initialization failed: %s", _init_error, exc_info=True
        )
    yield


app = FastAPI(title="synapse-embed", lifespan=lifespan)
tracing.setup_tracing("embed")
tracing.instrument_app(app)


class EmbedRequest(BaseModel):
    texts: list[str]
    input_type: str | None = None


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


def _run(texts: list[str]) -> list[list[float]]:
    return embed_texts(_model, texts).tolist()


@app.get("/healthz")
def healthz() -> dict:
    body = {
        "ok": True,
        "ready": _ready,
        "engine": "bge-m3",
        "model": MODEL_LABEL,
        "dim": EMBED_DIM,
    }
    if _init_error:
        body["error"] = _init_error
    return body


@app.post("/embed")
async def embed_endpoint(req: EmbedRequest):
    if not _ready:
        return JSONResponse(
            status_code=503, content={"error": "embedding model is not ready"}
        )
    # An empty batch is a valid no-op (not an error); return before acquiring.
    if not req.texts:
        return {"embeddings": [], "dim": EMBED_DIM, "model": MODEL_LABEL}
    if len(req.texts) > MAX_TEXTS:
        return JSONResponse(
            status_code=400,
            content={"error": f"too many texts (max {MAX_TEXTS})"},
        )
    if not await _try_acquire():
        return JSONResponse(
            status_code=503, content={"error": "embedding sidecar is busy"}
        )
    try:
        loop = asyncio.get_running_loop()
        try:
            embeddings = await loop.run_in_executor(_executor, _run, req.texts)
        except Exception as exc:  # noqa: BLE001 — engine error = retryable (5xx)
            return JSONResponse(
                status_code=500, content={"error": f"embed failed: {exc}"}
            )
        return {"embeddings": embeddings, "dim": EMBED_DIM, "model": MODEL_LABEL}
    finally:
        await _release()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("EMBED_HOST", "0.0.0.0"),
        port=int(os.environ.get("EMBED_PORT", "8775")),
    )
