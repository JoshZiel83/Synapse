// Generic OpenAI-compatible embedding provider — one adapter for the many vendors
// + self-host servers that speak POST {base_url}/embeddings with
// { model, input: string[] } → { data: [{ embedding, index }] }: OpenAI, Alibaba
// DashScope (百炼) compatible-mode, 智谱 Zhipu, 硅基流动 SiliconFlow, Gemini-compat,
// Ollama, TEI, Infinity, vLLM. Vendors that genuinely differ (Cohere /v2/embed,
// Voyage, Gemini native Batch) are documented Phase-2 seams, NOT this adapter.
//
// This adapter supplies only the request body (incl. the per-vendor input_type
// mapping + optional MRL `dimensions`), the auth header, and the response
// extractor; the fetch/timeout/never-reject/failure-classification live in
// buildHttpEmbeddingProvider. The facade enforces the dimension/norm contract.

import { config } from "../../../config/index.js"
import { createLogger } from "../../../infrastructure/logger/index.js"
import type { EmbedInput } from "../types.js"
import { asVectorRows, buildHttpEmbeddingProvider } from "./sidecar.js"

/** input_type → per-vendor request fields. Symmetric models ("none") add nothing —
 *  this includes the OpenAI-compat endpoints of DashScope / Zhipu / SiliconFlow,
 *  which do NOT honor a top-level asymmetric role field (that is a native-API-only
 *  feature). Jina's endpoint honors a top-level `task`. */
function roleFields(input: EmbedInput, mode: string): Record<string, unknown> {
  switch (mode) {
    case "jina-task":
      return {
        task:
          input.inputType === "query" ? "retrieval.query" : "retrieval.passage",
      }
    default:
      return {}
  }
}

/** Pull the ordered embedding rows out of an OpenAI-shaped `{ data: [...] }`
 *  response. Returns null (→ terminal) on any missing/misshaped field. */
function extractOpenAiVectors(
  data: Record<string, unknown>,
  count: number
): number[][] | null {
  const rows = data.data
  if (!Array.isArray(rows) || rows.length !== count) return null
  // Some vendors return `data` out of order → sort by the declared index.
  const indexOf = (row: unknown): number => {
    if (row && typeof row === "object" && "index" in row) {
      const idx = (row as { index?: unknown }).index
      return typeof idx === "number" ? idx : 0
    }
    return 0
  }
  const embeddingOf = (row: unknown): unknown =>
    row && typeof row === "object" && "embedding" in row
      ? (row as { embedding?: unknown }).embedding
      : undefined
  const sorted = [...rows].sort((a, b) => indexOf(a) - indexOf(b))
  return asVectorRows(sorted.map(embeddingOf), count)
}

const cfg = config.embedding.openai

export const openAiCompatibleProvider = buildHttpEmbeddingProvider({
  key: "openai-compatible",
  engineVersion: `${cfg.model || "openai-compatible"}:${config.embedding.dimension}`,
  model: cfg.model,
  dimension: config.embedding.dimension,
  // DashScope compat ≈ 10 inputs, Gemini-compat = 1; the facade splits larger
  // batches. 0/unset (default) => no cap.
  maxBatch: cfg.maxBatch > 0 ? cfg.maxBatch : undefined,
  log: createLogger("embedding.openai-compatible"),
  path: "embeddings",
  getUrl: () => cfg.baseUrl,
  getTimeoutMs: () => cfg.timeoutMs,
  isConfigured: () => Boolean(cfg.baseUrl && cfg.apiKey && cfg.model),
  buildHeaders: () => ({ authorization: `Bearer ${cfg.apiKey}` }),
  buildBody: (input) => ({
    model: cfg.model,
    input: input.texts,
    encoding_format: "float",
    // Request the configured width from MRL-capable models (DashScope v3/v4, Jina
    // v3, Zhipu embedding-3, OpenAI v3). Non-MRL models 400 / ignore it, so it is
    // gated on the per-deploy EMBEDDING_OPENAI_SUPPORTS_DIMENSIONS flag.
    ...(cfg.supportsDimensions
      ? { dimensions: config.embedding.dimension }
      : {}),
    ...roleFields(input, cfg.inputRoleMode),
  }),
  extractVectors: extractOpenAiVectors,
})
