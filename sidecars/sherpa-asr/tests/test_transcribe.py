"""Unit tests for the sherpa-asr text cleaning (pipeline.py).

These exercise the pure helpers WITHOUT sherpa-onnx / ffmpeg / numpy (not
importable in the plain test env — pipeline.py imports them lazily inside
build_recognizer / decode_to_pcm). The model + transcode path are covered by a
golden-audio check against the baked image (the Dockerfile's build-time recognizer
construction + a live /transcribe of the model's own test_wavs in CI).
"""

from pipeline import MODEL_LABEL, DecodeError, clean_text


def test_clean_text_strips_sensevoice_tags():
    assert (
        clean_text("<|zh|><|NEUTRAL|><|Speech|>开饭时间早上九点")
        == "开饭时间早上九点"
    )
    assert clean_text("<|en|><|HAPPY|><|Speech|>hello world") == "hello world"


def test_clean_text_trims_and_handles_empty():
    assert clean_text("  hello   world  ") == "hello   world"
    assert clean_text("") == ""
    assert clean_text(None) == ""


def test_model_label_default():
    assert MODEL_LABEL == "sensevoice-small"


def test_decode_error_is_value_error():
    # The sidecar relies on DecodeError being a distinct terminal (4xx) signal.
    assert issubclass(DecodeError, ValueError)
