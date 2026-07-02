"""Unit tests for PP-OCRv6 result extraction (pipeline.py).

These exercise the JSON-shaping logic WITHOUT paddlepaddle/opencv (not importable
in the plain test env — pipeline.py imports paddleocr only lazily inside
build_pipeline). The model itself is covered by a golden-image test in the
sidecar image / CI.
"""

import pytest

np = pytest.importorskip("numpy")

from pipeline import MODEL_LABEL, TIER, TIER_MODELS, extract_result  # noqa: E402


class _JsonResult:
    """Fake 3.x result object exposing only the res.json fallback path."""

    def __init__(self, payload):
        self.json = {"res": payload}


def test_extract_from_dict_result():
    res = {
        "rec_texts": ["hello", "world"],
        "rec_scores": [0.99, 0.88],
        "rec_polys": [
            np.array([[0, 0], [1, 0], [1, 1], [0, 1]]),
            np.array([[2, 2], [3, 2], [3, 3], [2, 3]]),
        ],
    }
    out = extract_result([res])
    assert out["text"] == "hello\nworld"
    assert [line["text"] for line in out["lines"]] == ["hello", "world"]
    assert out["lines"][0]["score"] == pytest.approx(0.99)
    assert out["lines"][0]["box"] == [[0, 0], [1, 0], [1, 1], [0, 1]]


def test_extract_from_json_fallback():
    res = _JsonResult(
        {
            "rec_texts": ["fallback"],
            "rec_scores": [0.5],
            "rec_polys": [[[0, 0], [1, 0], [1, 1], [0, 1]]],
        }
    )
    out = extract_result([res])
    assert out["text"] == "fallback"
    assert out["lines"][0]["score"] == pytest.approx(0.5)


def test_extract_empty():
    assert extract_result([]) == {"text": "", "lines": []}
    assert extract_result([{"rec_texts": [], "rec_scores": [], "rec_polys": []}]) == {
        "text": "",
        "lines": [],
    }


def test_model_label_matches_tier():
    assert MODEL_LABEL == f"PP-OCRv6_{TIER}"
    assert set(TIER_MODELS) == {"tiny", "small"}
