import crypto from "node:crypto"

export type MemoryEmbeddingInputType = "query" | "passage"

/** Provider-neutral normalization for cache keying: collapse whitespace + trim.
 *  The old E5 `${inputType}: ` prefix is GONE — that model-specific input
 *  convention now lives INSIDE each provider (the local bge-m3 sidecar / cloud
 *  adapters), so the cache hash must not bake it in or a provider swap would
 *  spuriously miss. `inputType` stays a separate cache-key discriminant at the
 *  call site (the Redis key + the memory_embedding_cache.input_type column). */
export function normalizeMemoryEmbeddingText(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

export function hashMemoryEmbeddingText(text: string) {
  return crypto
    .createHash("sha256")
    .update(normalizeMemoryEmbeddingText(text))
    .digest("hex")
}
