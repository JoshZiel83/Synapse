// pgvector `[..]`↔`::vector` (de)serialization for memory embeddings. Kept in the
// memory repo layer (the provider layer never sees a literal). Deduped from the
// two byte-identical copies that used to live in indexing.ts + repo.ts.

/** Format a dense vector as the pgvector text literal `[v1,v2,...]`. A non-finite
 *  value is written as 0 (defensive — the embedding facade already rejects
 *  non-finite rows before they reach here). */
export function formatEmbeddingVector(values: number[]): string {
  return `[${values
    .map((value) => (Number.isFinite(value) ? value.toFixed(8) : "0"))
    .join(",")}]`
}

/** Parse a pgvector `embedding::text` projection back into a number[], or null
 *  when it isn't a well-formed `[..]` literal with at least one finite value. */
export function parseEmbeddingVector(
  value: string | null | undefined
): number[] | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null
  const parts = trimmed
    .slice(1, -1)
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((part) => Number.isFinite(part))
  return parts.length > 0 ? parts : null
}
