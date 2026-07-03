"""Unit tests for the embed sidecar pure constants/helpers (pipeline.py).

These exercise the constants + EmbedError WITHOUT onnxruntime / tokenizers / numpy
(not importable in the plain test env — pipeline.py imports them lazily inside
build_model / embed_texts). The model + embed path is covered by a live check
against the baked image (the Dockerfile's build-time model construction + real
embed, and a /embed smoke test in CI).
"""

from pipeline import EMBED_DIM, MODEL_LABEL, EmbedError


def test_embed_dim_is_bge_m3_width():
    assert EMBED_DIM == 1024


def test_model_label():
    assert MODEL_LABEL == "bge-m3"


def test_embed_error_is_runtime_error():
    # serve.py maps an EmbedError to a 5xx (retryable) engine failure.
    assert issubclass(EmbedError, RuntimeError)
