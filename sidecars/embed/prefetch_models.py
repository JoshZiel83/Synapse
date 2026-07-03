"""Build-time bge-m3 ONNX weight + tokenizer prefetch.

Downloads only the base model.onnx (+ its external model.onnx_data) and tokenizer,
and copies them as FLAT real files into MODEL_ROOT (model.onnx + model.onnx_data +
tokenizer.json side by side — NOT the HF blobs/snapshots symlink layout, which
onnxruntime's external-data path check rejects) so runtime does no network I/O
(serve.py loads with local_files_only=True). HF_ENDPOINT can point at a mirror
(e.g. https://hf-mirror.com) for HF-blocked build networks.
"""

from pipeline import MODEL_LABEL, build_model, embed_texts

if __name__ == "__main__":
    # Force a full download (local_files_only=False) AND a real embed so a broken
    # download / mismatched export fails the BUILD, not the first request.
    model = build_model(local_files_only=False)
    vectors = embed_texts(model, ["prefetch"])
    print(
        f"prefetched {MODEL_LABEL} ONNX weights; embed shape {vectors.shape}, "
        f"norm {float((vectors[0] ** 2).sum()) ** 0.5:.4f}"
    )
