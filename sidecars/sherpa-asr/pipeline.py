"""sherpa-onnx SenseVoice ASR pipeline — recognizer construction + audio decode +
result cleaning. Shared by serve.py (runtime) and the Dockerfile's build-time
model check so the model set + decode path live in exactly one place.

The default model (SenseVoice-Small int8, zh/en/ja/ko/yue) is BAKED into the image
(infrastructure/Dockerfile.sherpa-asr) so runtime does no network I/O. It is
licensed under the Alibaba FunASR Model License (NOT Apache-2.0); the image retains
the model's LICENSE + name for the license's attribution requirement. To use a
different model, rebuild with --build-arg SHERPA_ASR_MODEL_URL=<a same-architecture
SenseVoice export>, or adapt build_recognizer() for another sherpa-onnx architecture.
"""

import os
import re
import subprocess
import tempfile

MODEL_DIR = os.environ.get("SHERPA_ASR_MODEL_DIR", "/app/models/sensevoice")
MODEL_LABEL = os.environ.get("SHERPA_ASR_MODEL_LABEL", "sensevoice-small")
SAMPLE_RATE = 16000

# Cap the DECODED duration: the byte-size gate bounds the compressed input, but a
# small low-bitrate clip can span hours and decode to gigabytes of 16 kHz mono
# float32 PCM (~64 KB/s) → OOM. ffmpeg -t truncates the output to this many
# seconds (default 30 min).
MAX_DURATION_SEC = int(os.environ.get("SHERPA_ASR_MAX_DURATION_SEC", "1800"))
# Hard wall-clock cap on the ffmpeg subprocess. The decode worker pool is a SINGLE
# thread, so a hung/pathological ffmpeg with no timeout would pin it forever and
# wedge the whole sidecar (permanent 503, /healthz never exercises decode → no
# self-recovery). subprocess.run(timeout=) kills the process and frees the thread.
FFMPEG_TIMEOUT_SEC = int(os.environ.get("SHERPA_ASR_FFMPEG_TIMEOUT_SEC", "60"))

# SenseVoice encodes language/emotion/event as <|...|> tokens. sherpa-onnx usually
# separates them into result.lang/.emotion/.event, but strip any that leak into
# .text so the api never sees the markup.
_TAG_RE = re.compile(r"<\|[^|]*\|>")


class DecodeError(ValueError):
    """The uploaded bytes are not decodable audio — a TERMINAL (non-retryable)
    condition, distinct from a recognizer/engine failure."""


def clean_text(raw: str | None) -> str:
    return _TAG_RE.sub("", raw or "").strip()


def build_recognizer():
    """Construct the SenseVoice offline recognizer. Imports sherpa_onnx lazily so
    pipeline.py's pure helpers (clean_text) stay importable in a test env without
    the native wheel."""
    import sherpa_onnx

    model = os.path.join(MODEL_DIR, "model.int8.onnx")
    tokens = os.path.join(MODEL_DIR, "tokens.txt")
    if not os.path.exists(model):
        raise FileNotFoundError(f"SenseVoice model not found at {model}")
    if not os.path.exists(tokens):
        raise FileNotFoundError(f"SenseVoice tokens not found at {tokens}")
    return sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=model,
        tokens=tokens,
        num_threads=int(os.environ.get("SHERPA_ASR_NUM_THREADS", "4")),
        # Inverse text normalization: "九点" -> "9点". Matches the SenseVoice
        # reference usage; the api normalizes whitespace on top.
        use_itn=True,
        debug=False,
    )


def decode_to_pcm(audio_bytes: bytes):
    """Transcode arbitrary audio (mp3/m4a/ogg/opus/webm/wav/flac/amr...) to 16 kHz
    mono float32 PCM via ffmpeg. Writes to a temp file first so ffmpeg can seek —
    m4a/mp4 keep their moov atom at the end and fail on a non-seekable pipe.
    Raises DecodeError (terminal) when the bytes aren't decodable audio."""
    import numpy as np

    with tempfile.NamedTemporaryFile(suffix=".input") as tmp:
        tmp.write(audio_bytes)
        tmp.flush()
        try:
            proc = subprocess.run(
                [
                    "ffmpeg",
                    "-nostdin",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-i",
                    tmp.name,
                    # Truncate the decoded output to bound PCM memory (see MAX_DURATION_SEC).
                    "-t",
                    str(MAX_DURATION_SEC),
                    "-f",
                    "f32le",
                    "-ac",
                    "1",
                    "-ar",
                    str(SAMPLE_RATE),
                    "pipe:1",
                ],
                capture_output=True,
                check=True,
                timeout=FFMPEG_TIMEOUT_SEC,
            )
        except subprocess.TimeoutExpired as exc:
            # subprocess.run has already killed the process, freeing the worker
            # thread. Treat a timed-out decode as terminal (a well-formed clip
            # decodes far faster than realtime; a timeout means pathological input).
            raise DecodeError(
                f"audio decode timed out after {FFMPEG_TIMEOUT_SEC}s"
            ) from exc
        except subprocess.CalledProcessError as exc:
            stderr = (
                exc.stderr.decode("utf-8", "replace").strip() if exc.stderr else ""
            )
            raise DecodeError(f"could not decode audio: {stderr or exc}") from exc
    return np.frombuffer(proc.stdout, dtype=np.float32)


def transcribe(recognizer, samples) -> dict:
    """Run one offline decode and return {text, language}. `text` is cleaned of
    SenseVoice markup; the api normalizes whitespace + caps length."""
    stream = recognizer.create_stream()
    stream.accept_waveform(SAMPLE_RATE, samples)
    recognizer.decode_stream(stream)
    result = stream.result
    language = (getattr(result, "lang", "") or "").strip("<|>") or None
    return {
        "text": clean_text(getattr(result, "text", "") or ""),
        "language": language,
    }
