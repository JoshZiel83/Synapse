"""Unit tests for the streaming pipeline's pure logic — no native sherpa-onnx wheel
and no model needed. StreamSession is driven by a scriptable fake recognizer; the
real recognizer + native decode are covered by the Docker build check + live smoke."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pipeline import StreamSession, pcm_s16le_to_float32  # noqa: E402


class _FakeStream:
    def __init__(self, recognizer):
        self._recognizer = recognizer

    def accept_waveform(self, _sample_rate, _samples):
        self._recognizer._advance()

    def input_finished(self):
        self._recognizer._advance(flush=True)


class FakeRecognizer:
    """Scriptable streaming recognizer. Each accept_waveform / input_finished consumes
    one (text, is_endpoint) entry; once the script is exhausted, input_finished marks
    an endpoint so finish() can flush the trailing hypothesis."""

    def __init__(self, script):
        self._script = list(script)
        self._current = ""
        self._endpoint = False

    def _advance(self, flush=False):
        if self._script:
            self._current, self._endpoint = self._script.pop(0)
        elif flush:
            self._endpoint = True

    def create_stream(self):
        return _FakeStream(self)

    def is_ready(self, _stream):
        return False

    def decode_stream(self, _stream):
        pass

    def get_result(self, _stream):
        return self._current

    def is_endpoint(self, _stream):
        return self._endpoint

    def reset(self, _stream):
        self._current = ""
        self._endpoint = False


def test_pcm_s16le_to_float32_converts_and_drops_odd_trailing_byte():
    import numpy as np

    data = np.array([0, 32767, -32768], dtype="<i2").tobytes()
    out = pcm_s16le_to_float32(data)
    assert out.shape == (3,)
    assert abs(float(out[1]) - 32767 / 32768) < 1e-4
    assert abs(float(out[2]) - (-1.0)) < 1e-6
    # An odd trailing byte (chunk boundary) is dropped, not misread.
    assert pcm_s16le_to_float32(data + b"\x01").shape == (3,)
    assert pcm_s16le_to_float32(b"").shape == (0,)


# One second of audio at 16 kHz → 16000 samples → 1000 ms, so segment offsets +
# durationMs are exact, round numbers in the assertions below.
_ONE_SECOND = [0.0] * 16000


def test_stream_session_emits_partial_then_final_on_endpoint():
    recognizer = FakeRecognizer([("你好", False), ("你好世界", True)])
    session = StreamSession(recognizer)

    first = session.accept_audio(_ONE_SECOND)
    assert first == [
        {"type": "partial", "displayText": "你好", "unstableText": "你好"}
    ]

    second = session.accept_audio(_ONE_SECOND)
    assert second[0] == {
        "type": "partial",
        "displayText": "你好世界",
        "unstableText": "你好世界",
    }
    assert second[1] == {
        "type": "final",
        "text": "你好世界",
        "segmentIndex": 0,
        "startTimeMs": 0,
        "endTimeMs": 2000,
    }


def test_stream_session_accumulates_segments_across_endpoints():
    recognizer = FakeRecognizer(
        [("first", True), ("second", True)]
    )
    session = StreamSession(recognizer)

    session.accept_audio(_ONE_SECOND)  # → final "first" (segment 0), reset
    out = session.accept_audio(_ONE_SECOND)  # → final "second" (segment 1)
    final = [m for m in out if m["type"] == "final"][0]
    assert final == {
        "type": "final",
        "text": "second",
        "segmentIndex": 1,
        "startTimeMs": 1000,
        "endTimeMs": 2000,
    }
    # The display text carries the accumulated finalized prefix.
    partial = [m for m in out if m["type"] == "partial"][0]
    assert partial["displayText"] == "firstsecond"


def test_stream_session_finish_finalizes_tail_and_completes():
    recognizer = FakeRecognizer([("hello", False)])
    session = StreamSession(recognizer)

    session.accept_audio(_ONE_SECOND)  # partial "hello", no endpoint
    out = session.finish()
    assert out[0] == {
        "type": "final",
        "text": "hello",
        "segmentIndex": 0,
        "startTimeMs": 0,
        "endTimeMs": 1000,
    }
    assert out[1] == {"type": "completed", "text": "hello", "durationMs": 1000}


def test_stream_session_finish_with_no_speech_completes_empty():
    recognizer = FakeRecognizer([])
    session = StreamSession(recognizer)
    out = session.finish()
    assert out == [{"type": "completed", "text": "", "durationMs": 0}]
