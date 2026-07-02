"""Build-time Whisper (faster-whisper CT2) weight prefetch.

Constructing WhisperModel(size, download_root=MODEL_ROOT) downloads the Systran CT2
conversion for that size into MODEL_ROOT (HF cache layout). Run this in the Docker
build so runtime does no network I/O (serve.py loads with local_files_only=True).
HF_ENDPOINT can point at a mirror (e.g. https://hf-mirror.com) for HF-blocked
build networks.
"""

from pipeline import MODEL_SIZE, build_model

if __name__ == "__main__":
    build_model(local_files_only=False)
    print(f"prefetched faster-whisper {MODEL_SIZE} weights")
