"""Build-time PP-OCRv6 weight prefetch.

Constructing the pipeline downloads the tier's det + rec + textline-ori weights
into the model cache (~/.paddlex/official_models). Run this in the Docker build
AS THE RUNTIME USER so the cache lands under that user's home, giving zero
network I/O at runtime. Source is HF by default; PADDLE_PDX_MODEL_SOURCE=BOS
switches to the BOS mirror for HF-blocked networks.
"""

from pipeline import TIER, build_pipeline

if __name__ == "__main__":
    build_pipeline(TIER)
    print(f"prefetched PP-OCRv6 {TIER} model weights")
