import { config } from "../../config/index.js"
import { redis } from "../../infrastructure/redis/index.js"
import { embedQuery, resolveEmbeddingProvider } from "../embedding/index.js"
import { parseMemoryEmbeddingCachePayload } from "./embedding-cache-codec.js"
import { hashMemoryEmbeddingText } from "./embedding-input.js"

// Durable (cross-process) query-embedding cache. Keyed by the active provider's
// engineVersion (model:dim) + inputType, so a provider/model swap cold-caches
// automatically (no stale cross-space hit) and two providers in the SAME space
// share entries. This is the ONLY query cache — the embedding facade intentionally
// does not add a second in-process one.
function buildQueryEmbeddingCacheKey(queryText: string) {
  const queryHash = hashMemoryEmbeddingText(queryText)
  const { engineVersion } = resolveEmbeddingProvider()
  return `memory:query-embedding:v2:${engineVersion}:query:${queryHash}`
}

export async function getCachedMemoryQueryEmbedding(queryText: string) {
  const cached = await redis.get(buildQueryEmbeddingCacheKey(queryText))
  return parseMemoryEmbeddingCachePayload(cached)
}

export async function setCachedMemoryQueryEmbedding(
  queryText: string,
  embedding: number[]
) {
  if (embedding.length === 0) return
  const ttl = Math.max(1, config.embedding.queryCacheTtlSec)
  await redis.set(
    buildQueryEmbeddingCacheKey(queryText),
    JSON.stringify(embedding),
    "EX",
    ttl
  )
}

/** Embed a recall query, served from the Redis cache when present. Returns the
 *  query vector or null (a null/failed embed → the caller degrades to lexical-only,
 *  see service.ts). Only successful embeds are cached, so a transient failure is
 *  never negatively cached. */
export async function embedMemoryQueryCached(queryText: string) {
  const cached = await getCachedMemoryQueryEmbedding(queryText)
  if (cached) return cached

  const result = await embedQuery(queryText)
  const embedding = result.ok ? result.vectors[0] : null
  if (embedding && embedding.length > 0) {
    await setCachedMemoryQueryEmbedding(queryText, embedding)
    return embedding
  }
  return null
}
