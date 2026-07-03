"""sherpa-onnx STREAMING ASR pipeline — online recognizer construction + the
per-connection decode orchestration. The realtime analogue of the batch
sidecars/sherpa-asr/pipeline.py.

The Synapse api bundles no ASR engine; the realtime /ws/asr gateway's sherpa-stream
provider (packages/api/src/modules/asr/providers/sherpa-stream) opens a WebSocket
here, streams raw 16 kHz mono s16le PCM, and receives partial/final/completed JSON.

`StreamSession` is pure orchestration over the sherpa-onnx OnlineRecognizer streaming
API (create_stream / accept_waveform / is_ready / decode_stream / get_result /
is_endpoint / reset). It is transport-agnostic (no FastAPI/WebSocket) so it is
unit-testable with a fake recognizer — the native wheel + a real model are exercised
only by the Docker build check + a live smoke test.

The default model (streaming zipformer bilingual zh-en, Apache-2.0) is BAKED into the
image so runtime does no network I/O. Swap it at build with
--build-arg SHERPA_STREAM_MODEL_URL=<a same-architecture streaming transducer export>.
"""

import glob
import os

MODEL_DIR = os.environ.get("SHERPA_STREAM_MODEL_DIR", "/app/models/streaming")
MODEL_LABEL = os.environ.get("SHERPA_STREAM_MODEL_LABEL", "streaming-zipformer-zh-en")
SAMPLE_RATE = 16000


def pcm_s16le_to_float32(data: bytes):
    """Convert little-endian 16-bit PCM bytes to the float32 [-1, 1] samples the
    recognizer expects. An odd trailing byte (partial sample from a chunk boundary)
    is dropped."""
    import numpy as np

    usable = len(data) - (len(data) % 2)
    if usable <= 0:
        return np.zeros(0, dtype=np.float32)
    ints = np.frombuffer(data[:usable], dtype="<i2")
    return ints.astype(np.float32) / 32768.0


def _find_model_file(prefix: str) -> str:
    """Locate encoder/decoder/joiner by prefix, preferring the smaller int8 export."""
    int8 = sorted(glob.glob(os.path.join(MODEL_DIR, f"{prefix}*.int8.onnx")))
    plain = sorted(
        f
        for f in glob.glob(os.path.join(MODEL_DIR, f"{prefix}*.onnx"))
        if not f.endswith(".int8.onnx")
    )
    matches = int8 or plain
    if not matches:
        raise FileNotFoundError(f"streaming model {prefix}*.onnx not found in {MODEL_DIR}")
    return matches[0]


def build_recognizer():
    """Construct the streaming transducer recognizer. Imports sherpa_onnx lazily so
    this module's pure helpers stay importable in a test env without the native wheel."""
    import sherpa_onnx

    tokens = os.path.join(MODEL_DIR, "tokens.txt")
    if not os.path.exists(tokens):
        raise FileNotFoundError(f"streaming model tokens.txt not found in {MODEL_DIR}")
    return sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=tokens,
        encoder=_find_model_file("encoder"),
        decoder=_find_model_file("decoder"),
        joiner=_find_model_file("joiner"),
        num_threads=int(os.environ.get("SHERPA_STREAM_NUM_THREADS", "2")),
        sample_rate=SAMPLE_RATE,
        feature_dim=80,
        # Endpoint detection turns a continuous stream into utterance segments.
        enable_endpoint_detection=True,
        rule1_min_trailing_silence=2.4,
        rule2_min_trailing_silence=1.2,
        rule3_min_utterance_length=300,
        decoding_method="greedy_search",
        provider="cpu",
    )


class StreamSession:
    """Drives one streaming connection. Feed audio via accept_audio(); flush at the
    end via finish(). Both return an ordered list of protocol messages (dicts) for
    the transport layer to serialize to the client. `display`/`unstable` mirror the
    canonical asr.partial fields; a finalized utterance becomes a `final` message."""

    def __init__(self, recognizer):
        self._recognizer = recognizer
        self._stream = recognizer.create_stream()
        self._finalized: list[str] = []
        self._segment_index = 0
        # Cumulative audio fed so far, and where the current (un-finalized) segment
        # began — used to stamp real segment offsets + the total durationMs (16 kHz,
        # so ms = samples * 1000 / SAMPLE_RATE).
        self._total_samples = 0
        self._segment_start_samples = 0

    def _drain_decode(self) -> str:
        while self._recognizer.is_ready(self._stream):
            self._recognizer.decode_stream(self._stream)
        return (self._recognizer.get_result(self._stream) or "").strip()

    def _finalized_text(self) -> str:
        return "".join(self._finalized)

    def _partial_message(self, current: str) -> dict:
        display = self._finalized_text() + current
        return {"type": "partial", "displayText": display, "unstableText": current}

    def _final_message(self, current: str) -> dict:
        message = {
            "type": "final",
            "text": current,
            "segmentIndex": self._segment_index,
            "startTimeMs": round(self._segment_start_samples * 1000 / SAMPLE_RATE),
            "endTimeMs": round(self._total_samples * 1000 / SAMPLE_RATE),
        }
        self._finalized.append(current)
        self._segment_index += 1
        self._segment_start_samples = self._total_samples
        return message

    def accept_audio(self, samples) -> list[dict]:
        self._total_samples += len(samples)
        self._stream.accept_waveform(SAMPLE_RATE, samples)
        current = self._drain_decode()
        messages: list[dict] = [self._partial_message(current)]
        if self._recognizer.is_endpoint(self._stream):
            if current:
                messages.append(self._final_message(current))
            self._recognizer.reset(self._stream)
        return messages

    def finish(self) -> list[dict]:
        """Flush the tail: mark input finished, decode what remains, finalize any
        trailing hypothesis, and emit a terminal `completed`."""
        self._stream.input_finished()
        current = self._drain_decode()
        messages: list[dict] = []
        if current:
            messages.append(self._final_message(current))
        messages.append(
            {
                "type": "completed",
                "text": self._finalized_text(),
                "durationMs": round(self._total_samples * 1000 / SAMPLE_RATE),
            }
        )
        return messages
