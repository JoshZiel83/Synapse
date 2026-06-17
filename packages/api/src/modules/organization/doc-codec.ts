import {
  normalizeActorDocs,
  type ActorDoc,
  type ActorDocInput,
} from "@synapse/shared"

export function readDecodedArray<T>(value: unknown): T[] {
  if (!value) return []
  return Array.isArray(value) ? (value as T[]) : []
}

export function sortDocs(docs: ActorDoc[]) {
  return [...docs].sort((left, right) => {
    if (right.priority !== left.priority) return right.priority - left.priority
    return left.title.localeCompare(right.title)
  })
}

export function normalizeActorDocInputs(docs: unknown): ActorDoc[] {
  return sortDocs(normalizeActorDocs(readDecodedArray<ActorDocInput>(docs)))
}

export function sanitizeSpecialties(specialties?: string[]) {
  return Array.from(
    new Set((specialties || []).map((value) => value.trim()).filter(Boolean))
  )
}
