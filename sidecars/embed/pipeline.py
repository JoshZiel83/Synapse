"""Embedding sidecar pipeline — onnxruntime + tokenizers over bge-m3 (Xenova/bge-m3
ONNX, CPU). NO torch.

The Synapse api bundles NO embedding engine; it POSTs texts here and gets back
dense 1024-d L2-normalized vectors (BAAI/bge-m3 dense). We run the base
`onnx/model.onnx` (XLM-RoBERTa) and pool it ourselves: bge-m3 dense =
L2-normalize(last_hidden_state[:, 0]) — the [CLS] token (verified: BAAI/bge-m3
1_Pooling uses CLS; hidden_size 1024). bge-m3 is symmetric for retrieval (no
query/passage instruction), so input_type is accepted for api-interface parity but
does not change the output.

Weights + tokenizer are baked at build (prefetch_models.py) as FLAT real files in
MODEL_ROOT — NOT the HF cache blobs/snapshots symlink layout, which onnxruntime's
external-data path check rejects (the .onnx references the sibling .onnx_data by
name, which must resolve inside the model dir). Runtime loads offline. Shared by
serve.py + the Dockerfile's build-time assertion so model + embed live in one place;
heavy libs are imported lazily so the pure constants stay importable in a plain
test env.
"""

import os

MODEL_REPO = os.environ.get("EMBED_MODEL_REPO", "Xenova/bge-m3")
MODEL_LABEL = os.environ.get("EMBED_MODEL_LABEL", "bge-m3")
EMBED_DIM = int(os.environ.get("EMBED_DIM", "1024"))
# Flat dir holding the baked real files (model.onnx + model.onnx_data + tokenizer).
MODEL_ROOT = os.environ.get("EMBED_MODEL_ROOT", "/app/models/embed")
# bge-m3 supports 8192 tokens; memory chunks are ~1k chars so this is a ceiling,
# not a live truncation point.
MAX_SEQ_LEN = int(os.environ.get("EMBED_MAX_SEQ_LEN", "8192"))
ONNX_THREADS = int(os.environ.get("EMBED_ONNX_THREADS", "4"))

_ONNX_FILE = "model.onnx"
_ONNX_DATA_FILE = "model.onnx_data"
_TOKENIZER_FILE = "tokenizer.json"

# Only these repo files are pulled at build (NOT the ~10 quantized variants) so the
# bake stays ~2.3 GB. model.onnx holds the graph; model.onnx_data the weights.
_REPO_FILES = [
    ("onnx/model.onnx", _ONNX_FILE),
    ("onnx/model.onnx_data", _ONNX_DATA_FILE),
    ("tokenizer.json", _TOKENIZER_FILE),
]


class EmbedError(RuntimeError):
    """Engine failure (distinct from a bad request)."""


class EmbeddingModel:
    """Loaded tokenizer + onnxruntime session + the chosen token-embedding output."""

    def __init__(self, tokenizer, session, input_names, output_name):
        self.tokenizer = tokenizer
        self.session = session
        self.input_names = input_names
        self.output_name = output_name


def _download_flat(dest: str) -> None:
    """Build-time: download the needed repo files and copy them (real bytes,
    resolving the HF symlink cache) FLAT into `dest`, so the .onnx and its external
    .onnx_data sit side by side as real files. HF_ENDPOINT can point at a mirror
    (e.g. https://hf-mirror.com) for HF-blocked build networks."""
    import shutil
    import tempfile

    from huggingface_hub import snapshot_download

    os.makedirs(dest, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        snap = snapshot_download(
            MODEL_REPO,
            cache_dir=tmp,
            allow_patterns=[rel for rel, _ in _REPO_FILES],
        )
        for rel, name in _REPO_FILES:
            shutil.copy(os.path.join(snap, rel), os.path.join(dest, name))
    # `tmp` (the ~2.3 GB HF cache) is removed on context exit, so only the flat
    # copies remain in the Docker layer.


def build_model(local_files_only: bool = True) -> EmbeddingModel:
    """Construct the embedding model from the flat baked files in MODEL_ROOT. When
    local_files_only=False (build time), download + flatten first."""
    import onnxruntime as ort
    from tokenizers import Tokenizer

    if not local_files_only:
        _download_flat(MODEL_ROOT)

    onnx_path = os.path.join(MODEL_ROOT, _ONNX_FILE)
    tokenizer = Tokenizer.from_file(os.path.join(MODEL_ROOT, _TOKENIZER_FILE))
    tokenizer.enable_truncation(max_length=MAX_SEQ_LEN)
    # Pad to the longest row per batch so encode_batch yields a rectangular matrix.
    # XLM-R pad token is "<pad>"; fall back to id 1 if not exposed.
    pad_id = tokenizer.token_to_id("<pad>")
    tokenizer.enable_padding(
        pad_id=pad_id if pad_id is not None else 1, pad_token="<pad>"
    )

    so = ort.SessionOptions()
    so.intra_op_num_threads = ONNX_THREADS
    so.inter_op_num_threads = 1
    session = ort.InferenceSession(
        onnx_path, sess_options=so, providers=["CPUExecutionProvider"]
    )

    input_names = {i.name for i in session.get_inputs()}
    output_names = [o.name for o in session.get_outputs()]
    # bge-m3 dense pools the CLS token of last_hidden_state — select it explicitly
    # (never the pooler_output, whose tanh would corrupt the dense vector).
    output_name = (
        "last_hidden_state"
        if "last_hidden_state" in output_names
        else output_names[0]
    )
    return EmbeddingModel(tokenizer, session, input_names, output_name)


def embed_texts(model: EmbeddingModel, texts):
    """Embed a batch of texts → an (N, EMBED_DIM) float32 numpy array of
    L2-normalized dense vectors. Raises EmbedError if the graph emits a wrong-width
    vector (a broken/mismatched model must fail LOUD, never return a bad shape the
    api would try to persist)."""
    import numpy as np

    texts = list(texts)
    if not texts:
        return np.zeros((0, EMBED_DIM), dtype=np.float32)

    encodings = model.tokenizer.encode_batch(texts)
    input_ids = np.array([e.ids for e in encodings], dtype=np.int64)
    attention_mask = np.array(
        [e.attention_mask for e in encodings], dtype=np.int64
    )

    feeds = {}
    if "input_ids" in model.input_names:
        feeds["input_ids"] = input_ids
    if "attention_mask" in model.input_names:
        feeds["attention_mask"] = attention_mask
    # XLM-R has no token_type_ids, but if the export declares it, feed zeros.
    if "token_type_ids" in model.input_names:
        feeds["token_type_ids"] = np.zeros_like(input_ids)

    out = np.asarray(
        model.session.run([model.output_name], feeds)[0], dtype=np.float32
    )
    # last_hidden_state is (batch, seq, hidden) → CLS-pool the [CLS] token. A
    # pre-pooled (2D) export would pass through.
    if out.ndim == 3:
        out = out[:, 0, :]
    if out.ndim != 2 or out.shape[1] != EMBED_DIM:
        raise EmbedError(
            f"embedding model emitted shape {out.shape}, expected (*, {EMBED_DIM})"
        )

    # L2-normalize for cosine (guard a zero-norm row from becoming NaN).
    norms = np.linalg.norm(out, axis=1, keepdims=True)
    norms = np.where(norms < 1e-12, 1.0, norms)
    return (out / norms).astype(np.float32)
