"""Golden-image test for the tesseract sidecar.

Renders known text to an image with PIL, runs the sidecar's OCR path, and
asserts the text round-trips. Skipped automatically when the native `tesseract`
binary (or its deps) isn't available in the test environment — it runs inside
the sidecar image / CI where tesseract-ocr is installed.
"""

import base64
import io

import pytest

pytest.importorskip("PIL")
pytest.importorskip("pytesseract")

from PIL import Image, ImageDraw  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import serve  # noqa: E402


def _tesseract_available() -> bool:
    try:
        import pytesseract

        pytesseract.get_tesseract_version()
        return True
    except Exception:  # noqa: BLE001
        return False


requires_tesseract = pytest.mark.skipif(
    not _tesseract_available(), reason="native tesseract binary not installed"
)


def _png_with_text(text: str) -> bytes:
    img = Image.new("RGB", (320, 80), color="white")
    ImageDraw.Draw(img).text((10, 25), text, fill="black")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def test_healthz_reports_ready():
    client = TestClient(serve.app)
    res = client.get("/healthz")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True and body["ready"] is True


@requires_tesseract
def test_ocr_round_trips_rendered_text():
    client = TestClient(serve.app)
    payload = {
        "image_base64": base64.b64encode(_png_with_text("HELLO OCR")).decode(),
        "mime_type": "image/png",
        "langs": "eng",
    }
    res = client.post("/ocr", json=payload)
    assert res.status_code == 200
    assert "HELLO" in res.json()["text"].upper()


def test_ocr_rejects_invalid_base64():
    client = TestClient(serve.app)
    res = client.post(
        "/ocr", json={"image_base64": "!!!not-base64!!!", "mime_type": "image/png"}
    )
    assert res.status_code == 400
