"""Whisper ASR pipeline — faster-whisper (CTranslate2) model construction + audio
decode + transcription. Shared by serve.py (runtime) and the Dockerfile's
build-time model check + prefetch so the model + decode path live in one place.

The model SIZE (tiny|base|small|medium|large-v3|...) is a BUILD choice baked into
the image (infrastructure/Dockerfile.whisper) via WHISPER_MODEL_SIZE — the
faster-whisper CT2 weights are downloaded at build so runtime does no network I/O.
Both the Whisper weights (OpenAI) and the Systran CT2 conversions are MIT — this is
the permissive-license alternative to the sherpa/SenseVoice default.

The ffmpeg decode (bounded timeout + duration cap) mirrors the sherpa-asr sidecar;
kept self-contained here so each sidecar image builds independently.
"""

import os
import subprocess
import tempfile

MODEL_ROOT = os.environ.get("WHISPER_MODEL_ROOT", "/app/models/whisper")
MODEL_SIZE = os.environ.get("WHISPER_MODEL_SIZE", "small")
MODEL_LABEL = f"whisper-{MODEL_SIZE}"
SAMPLE_RATE = 16000

# Cap the DECODED duration (ffmpeg -t): a small low-bitrate clip can span hours and
# decode to gigabytes of 16 kHz mono float32 PCM → OOM. Default 30 min.
MAX_DURATION_SEC = int(os.environ.get("WHISPER_MAX_DURATION_SEC", "1800"))
# Hard wall-clock cap on the ffmpeg decode subprocess. The decode+inference worker
# pool is a SINGLE thread, so a hung ffmpeg with no timeout would pin it forever
# and wedge the sidecar. subprocess.run(timeout=) kills it and frees the thread.
FFMPEG_TIMEOUT_SEC = int(os.environ.get("WHISPER_FFMPEG_TIMEOUT_SEC", "120"))
BEAM_SIZE = int(os.environ.get("WHISPER_BEAM_SIZE", "5"))
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
# Wall-clock budget for the INFERENCE itself (distinct from the ffmpeg decode
# cap). Whisper is autoregressive → far slower than the non-autoregressive
# SenseVoice, and a CTranslate2 inference cannot be cancelled mid-call. Since
# faster-whisper yields segments LAZILY (inference for the next segment runs when
# it is pulled), we stop pulling past this budget → a partial transcript + a freed
# worker thread, instead of grinding an already-abandoned long inference (the api
# gave up at its request timeout) and starving the single decode thread.
INFER_BUDGET_SEC = int(os.environ.get("WHISPER_INFER_BUDGET_SEC", "120"))


class DecodeError(ValueError):
    """The uploaded bytes are not decodable audio — a TERMINAL (non-retryable)
    condition, distinct from a model/engine failure."""


def clean_text(raw: str | None) -> str:
    return (raw or "").strip()


def build_model(local_files_only: bool = True):
    """Construct the faster-whisper model. Imports faster_whisper lazily so
    pipeline.py's pure helpers (clean_text) stay importable in a test env without
    the native wheel. At build time prefetch_models.py passes
    local_files_only=False to download; runtime loads offline from MODEL_ROOT."""
    from faster_whisper import WhisperModel

    return WhisperModel(
        MODEL_SIZE,
        device="cpu",
        compute_type=COMPUTE_TYPE,
        download_root=MODEL_ROOT,
        local_files_only=local_files_only,
        cpu_threads=int(os.environ.get("WHISPER_CPU_THREADS", "4")),
    )


def decode_to_pcm(audio_bytes: bytes):
    """Transcode arbitrary audio (mp3/m4a/ogg/opus/webm/wav/flac/amr...) to 16 kHz
    mono float32 PCM via ffmpeg. Writes to a temp file first so ffmpeg can seek —
    m4a/mp4 keep their moov atom at the end and fail on a non-seekable pipe. Raises
    DecodeError (terminal) when the bytes aren't decodable or the decode times out."""
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
            raise DecodeError(
                f"audio decode timed out after {FFMPEG_TIMEOUT_SEC}s"
            ) from exc
        except subprocess.CalledProcessError as exc:
            stderr = (
                exc.stderr.decode("utf-8", "replace").strip() if exc.stderr else ""
            )
            raise DecodeError(f"could not decode audio: {stderr or exc}") from exc
    return np.frombuffer(proc.stdout, dtype=np.float32)


def transcribe(model, samples) -> dict:
    """Run one transcription over decoded PCM samples and return {text, language}.
    faster-whisper returns a LAZY segment generator (inference for each segment
    runs when pulled), so consumption is time-boxed by INFER_BUDGET_SEC: past the
    budget we stop pulling and return a partial transcript, freeing the single
    worker thread rather than grinding an abandoned long inference. `info.language`
    comes from the upfront language-detection pass, so it is valid even on an
    early break."""
    import time

    segments, info = model.transcribe(samples, beam_size=BEAM_SIZE)
    deadline = time.monotonic() + INFER_BUDGET_SEC
    parts = []
    for segment in segments:
        parts.append(segment.text)
        if time.monotonic() >= deadline:
            break
    text = clean_text("".join(parts))
    return {"text": text, "language": getattr(info, "language", None)}
