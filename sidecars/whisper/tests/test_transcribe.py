"""Unit tests for the whisper sidecar pure helpers (pipeline.py).

These exercise clean_text + the label WITHOUT faster-whisper / ffmpeg / numpy (not
importable in the plain test env — pipeline.py imports them lazily inside
build_model / decode_to_pcm). The model + transcode path are covered by a
golden-audio check against the baked image (the Dockerfile's build-time model
construction + a live /transcribe in CI).
"""

from pipeline import MODEL_LABEL, MODEL_SIZE, DecodeError, clean_text


def test_clean_text_trims_and_handles_empty():
    assert clean_text("  hello world  ") == "hello world"
    assert clean_text("") == ""
    assert clean_text(None) == ""


def test_model_label_matches_size():
    assert MODEL_LABEL == f"whisper-{MODEL_SIZE}"


def test_decode_error_is_value_error():
    # The sidecar relies on DecodeError being a distinct terminal (4xx) signal.
    assert issubclass(DecodeError, ValueError)
