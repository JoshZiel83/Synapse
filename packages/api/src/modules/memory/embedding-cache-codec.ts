import { z } from "zod"

const memoryEmbeddingCachePayloadSchema = z.array(z.number().finite()).min(1)

export function parseMemoryEmbeddingCachePayload(
  raw: string | null
): number[] | null {
  if (!raw) return null

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }

  const parsed = memoryEmbeddingCachePayloadSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
