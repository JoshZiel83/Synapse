"""PP-OCRv6 pipeline construction + result extraction.

Shared by serve.py (runtime) and prefetch_models.py (build-time weight download)
so the model set is defined in exactly one place. Uses the official `paddleocr`
package (>=3.7, which ships PP-OCRv6) on the CPU PaddlePaddle backend.

Tier is a BUILD-TIME choice: the selected tier's weights are baked into the
image (infrastructure/Dockerfile.ppocr) so runtime does no network I/O. To
switch tiers, rebuild with --build-arg PPOCR_TIER=<tier>.
"""

import os
from typing import Any

# det + rec model names per tier (confirmed from the PP-OCRv6 HF collection).
TIER_MODELS = {
    "tiny": {"det": "PP-OCRv6_tiny_det", "rec": "PP-OCRv6_tiny_rec"},
    "small": {"det": "PP-OCRv6_small_det", "rec": "PP-OCRv6_small_rec"},
}
# Ultra-light text-line orientation model (shared across tiers).
TEXTLINE_MODEL = "PP-LCNet_x0_25_textline_ori"

TIER = os.environ.get("PPOCR_TIER", "small").strip().lower() or "small"
if TIER not in TIER_MODELS:
    raise ValueError(f"invalid PPOCR_TIER={TIER!r}; expected one of {list(TIER_MODELS)}")

# The image bakes exactly ONE tier's weights (Dockerfile prefetch sets
# PPOCR_BAKED_TIER). If the runtime PPOCR_TIER drifts from the baked tier (e.g.
# changed in .env without a rebuild), fail fast at import — otherwise the sidecar
# would silently try to download the unbaked tier at runtime, which fails on an
# offline/egress-blocked host.
_BAKED_TIER = os.environ.get("PPOCR_BAKED_TIER", "").strip().lower()
if _BAKED_TIER and _BAKED_TIER != TIER:
    raise ValueError(
        f"PPOCR_TIER={TIER!r} but this image baked tier {_BAKED_TIER!r}; "
        f"rebuild with --build-arg PPOCR_TIER={TIER} or set PPOCR_TIER={_BAKED_TIER}"
    )

MODEL_LABEL = f"PP-OCRv6_{TIER}"


def build_pipeline(tier: str = TIER):
    """Construct a PP-OCRv6 pipeline for `tier` on CPU.

    Constructing triggers the weight download (into ~/.paddlex/official_models)
    when not already cached — which is exactly how the build layer pre-fetches.
    HPI is left OFF (buggy on CPU + ONNXRuntime, PaddleOCR #16484); we use the
    default Paddle engine with MKL-DNN. doc-orientation + doc-unwarping are
    disabled (unneeded for screenshots) so those models are never loaded.
    """
    from paddleocr import PaddleOCR

    models = TIER_MODELS[tier]
    return PaddleOCR(
        text_detection_model_name=models["det"],
        text_recognition_model_name=models["rec"],
        textline_orientation_model_name=TEXTLINE_MODEL,
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=True,
        device="cpu",
        cpu_threads=int(os.environ.get("PPOCR_CPU_THREADS", "8")),
        enable_mkldnn=True,
    )


def _result_fields(res: Any) -> dict:
    """Extract the parallel rec_* lists from a 3.x result object robustly.

    Prefer dict-style access (`res["rec_texts"]`, used by community 3.x code);
    fall back to the documented `res.json["res"]` form when the object isn't
    directly indexable on a given wheel.
    """
    def _via_index() -> dict | None:
        try:
            return {
                "texts": list(res["rec_texts"]),
                "scores": list(res["rec_scores"]),
                "polys": list(res["rec_polys"]),
            }
        except (KeyError, TypeError, ValueError):
            return None

    def _via_json() -> dict | None:
        payload = getattr(res, "json", None)
        if callable(payload):
            try:
                payload = payload()
            except Exception:  # noqa: BLE001
                payload = None
        if isinstance(payload, dict):
            inner = payload.get("res", payload)
            if isinstance(inner, dict) and "rec_texts" in inner:
                return {
                    "texts": list(inner.get("rec_texts", [])),
                    "scores": list(inner.get("rec_scores", [])),
                    "polys": list(inner.get("rec_polys", [])),
                }
        return None

    return _via_index() or _via_json() or {"texts": [], "scores": [], "polys": []}


def _to_list(value: Any):
    tolist = getattr(value, "tolist", None)
    return tolist() if callable(tolist) else value


def extract_result(results: list) -> dict:
    """Turn `pipeline.predict()` output into {text, lines} JSON-safe dicts.

    `text` is the newline-joined recognized lines (the api normalizes it). Each
    line carries the recognized text, its 0..1-ish confidence score, and the
    detection polygon (JSON-safe list), so richer downstream use is possible.
    """
    if not results:
        return {"text": "", "lines": []}

    fields = _result_fields(results[0])
    texts = fields["texts"]
    scores = fields["scores"]
    polys = fields["polys"]

    lines = []
    for i, text in enumerate(texts):
        lines.append(
            {
                "text": text,
                "score": float(scores[i]) if i < len(scores) else None,
                "box": _to_list(polys[i]) if i < len(polys) else None,
            }
        )
    return {"text": "\n".join(texts), "lines": lines}
