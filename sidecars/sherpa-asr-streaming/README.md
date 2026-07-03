# sherpa-asr-streaming sidecar

Self-hosted **streaming** (realtime) ASR for Synapse — the back-end for the api's
`/ws/asr` dictation gateway when `ASR_PROVIDER=sherpa-stream`. Lets realtime
dictation run fully on-prem with no cloud egress. The realtime analogue of the
batch [`sherpa-asr`](../sherpa-asr) sidecar.

- **Engine:** sherpa-onnx `OnlineRecognizer` (streaming zipformer transducer,
  bilingual zh-en by default, Apache-2.0, int8, baked into the image).
- **Transport:** a WebSocket. The api forwards **raw 16 kHz mono s16le PCM**; this
  sidecar never transcodes (no ffmpeg). Streaming opus/other-container decode is a
  deferred follow-up — the `sherpa-stream` adapter rejects non-PCM configs up front.

## Wire contract (owned by both this sidecar and the api's sherpa-stream adapter)

```
GET  /healthz -> {"ok": true, "ready": <bool>, "engine": "sherpa-asr-streaming", "model": ...}
WS   /ws
  client -> text   {"type": "start", "sampleRate": 16000}   (optional, ignored)
         -> binary <16 kHz mono s16le PCM frames>
         -> text   {"type": "stop"}
  server -> text   {"type": "partial",   "displayText": ..., "unstableText": ...}
         -> text   {"type": "final",     "text": ..., "segmentIndex": N}
         -> text   {"type": "completed", "text": ...}
         -> text   {"type": "error",     "message": ...}
```

## Run

```sh
# Via compose (opt-in `asr` profile). Set ASR_PROVIDER=sherpa-stream on the api.
docker compose --profile production --profile asr up -d --build sherpa-asr-streaming api
```

`REALTIME_ASR_SHERPA_URL` on the api defaults to `ws://sherpa-asr-streaming:8774/ws`.

## Tests

```sh
python -m pytest tests/          # pure StreamSession orchestration + PCM conversion
```

The unit tests use a fake recognizer (no native wheel / model needed). The real
recognizer + native decode are exercised by the Docker build check
(`build_recognizer()`) and a live WebSocket smoke test.

## Notes / limits

- A single shared recognizer; every decode runs on one worker thread (serialized).
  `SHERPA_STREAM_MAX_CONCURRENCY` (default 4) bounds concurrent WebSocket sessions
  and should match the api's `REALTIME_ASR_SHERPA_MAX_CONCURRENCY`.
- Endpoint detection (`rule1/2/3_min_trailing_silence`) turns the continuous stream
  into utterance segments (`final` messages); `stop` flushes the tail + `completed`.
