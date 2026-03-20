import { extractText, type Actor } from "@synapse/shared"

export type ChiefActorOption = {
  id: string
  name: string
  role: string
  title: string
  summary?: string
  avatarUrl?: string
  emoji?: string
  isActive: boolean
}

function buildActorSummary(actor: Actor) {
  const docs = [...actor.definition.docs].sort(
    (left, right) => right.priority - left.priority
  )

  for (const doc of docs) {
    const text = extractText(doc.content).replace(/\s+/g, " ").trim()
    if (text) return text.slice(0, 160)
  }

  return actor.definition.title || actor.definition.role
}

export function normalizeChiefActorOption(actor: Actor): ChiefActorOption {
  return {
    id: actor.id,
    name: actor.definition.name,
    role: actor.definition.role,
    title: actor.definition.title,
    summary: buildActorSummary(actor),
    avatarUrl: actor.avatarUrl,
    emoji:
      typeof actor.definition.config.avatar_emoji === "string"
        ? actor.definition.config.avatar_emoji
        : undefined,
    isActive: actor.isActive,
  }
}
