import { config } from "../../config/index.js"
import { redis } from "../../infrastructure/redis/index.js"
import { hashMemoryEmbeddingText } from "./embedding-input.js"
import { embedMemoryQuery } from "./embedding-runtime.js"

function buildQueryEmbeddingCacheKey(queryText: string) {
  const queryHash = hashMemoryEmbeddingText(queryText, "query")
  return `memory:query-embedding:v1:${config.memory.modelId}:${queryHash}`
}

function parseEmbeddingPayload(raw: string | null) {
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    if (!Array.isArray(value)) return null
    const embedding = value
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item))
    return embedding.length > 0 ? embedding : null
  } catch {
    return null
  }
}

export async function getCachedMemoryQueryEmbedding(queryText: string) {
  const cached = await redis.get(buildQueryEmbeddingCacheKey(queryText))
  return parseEmbeddingPayload(cached)
}

export async function setCachedMemoryQueryEmbedding(
  queryText: string,
  embedding: number[]
) {
  if (embedding.length === 0) return
  const ttl = Math.max(1, config.memory.queryEmbedCacheTtlSec)
  await redis.set(
    buildQueryEmbeddingCacheKey(queryText),
    JSON.stringify(embedding),
    "EX",
    ttl
  )
}

export async function embedMemoryQueryCached(queryText: string) {
  const cached = await getCachedMemoryQueryEmbedding(queryText)
  if (cached) return cached

  const embedding = await embedMemoryQuery(queryText)
  if (embedding && embedding.length > 0) {
    await setCachedMemoryQueryEmbedding(queryText, embedding)
  }
  return embedding
}
