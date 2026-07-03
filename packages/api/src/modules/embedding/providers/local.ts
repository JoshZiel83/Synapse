// Local embedding provider — a thin HTTP client to the embed sidecar
// (sidecars/embed, bge-m3 dense over onnxruntime behind FastAPI). Per the
// zero-embedding-api decision the api runs NO embedding engine in-process. All the
// wire/retry logic lives in buildHttpEmbeddingProvider; this file only supplies the
// local-specific ids + config.
//
// engineVersion = `${model}:${dim}` (e.g. "bge-m3:1024") is the "one embedding
// space" identity: a cloud provider serving the SAME model+dim (e.g. SiliconFlow's
// BAAI/bge-m3) produces the same engineVersion, so switching between local and that
// cloud is space-compatible. bge-m3 is symmetric — the sidecar accepts input_type
// for parity but ignores it.

import { config } from "../../../config/index.js"
import { createLogger } from "../../../infrastructure/logger/index.js"
import { asVectorRows, buildHttpEmbeddingProvider } from "./sidecar.js"

export const localEmbeddingProvider = buildHttpEmbeddingProvider({
  key: "local",
  engineVersion: `${config.embedding.local.model}:${config.embedding.dimension}`,
  model: config.embedding.local.model,
  dimension: config.embedding.dimension,
  log: createLogger("embedding.local"),
  path: "embed",
  getUrl: () => config.embedding.local.url,
  getTimeoutMs: () => config.embedding.local.timeoutMs,
  buildBody: (input) => ({ texts: input.texts, input_type: input.inputType }),
  extractVectors: (data, count) => asVectorRows(data.embeddings, count),
})
