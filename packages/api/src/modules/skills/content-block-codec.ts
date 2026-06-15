import {
  normalizeCanonicalContentBlocks,
  type CanonicalContentBlockInput,
} from "@synapse/shared"

export function readDecodedArray<T>(value: unknown): T[] {
  if (!value) return []
  return Array.isArray(value) ? (value as T[]) : []
}

export function normalizeStoredBlocks(value: unknown) {
  return normalizeCanonicalContentBlocks(
    readDecodedArray<CanonicalContentBlockInput>(value)
  )
}
