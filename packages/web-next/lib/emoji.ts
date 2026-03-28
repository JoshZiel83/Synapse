import type { Emoji as EmojiMartEmoji, EmojiMartData } from "@emoji-mart/data"

const POPULAR_EMOJI_IDS = [
  "grinning",
  "joy",
  "smile",
  "rofl",
  "wink",
  "heart_eyes",
  "thinking_face",
  "sob",
  "fire",
  "thumbsup",
  "clap",
  "wave",
  "pray",
  "rocket",
  "sparkles",
  "eyes",
]

export type EmojiSuggestion = {
  id: string
  native: string
  label: string
  description: string
  searchTerms: string[]
}

type EmojiIndexEntry = EmojiSuggestion & {
  aliases: string[]
  emoticons: string[]
  popularity: number
}

let emojiIndexPromise: Promise<EmojiIndexEntry[]> | null = null

function normalizeQuery(value: string) {
  return value.trim().replace(/^:+/, "").toLowerCase()
}

function buildEmojiSearchTerms(
  emoji: EmojiMartEmoji,
  aliases: string[]
): string[] {
  return Array.from(
    new Set(
      [
        emoji.id,
        emoji.name,
        ...aliases,
        ...(emoji.keywords || []),
        ...(emoji.emoticons || []),
      ]
        .map((term) => term.trim().toLowerCase())
        .filter(Boolean)
    )
  )
}

function buildEmojiIndex(data: EmojiMartData): EmojiIndexEntry[] {
  const aliasesById = new Map<string, string[]>()

  for (const [alias, emojiId] of Object.entries(data.aliases || {})) {
    const bucket = aliasesById.get(emojiId) || []
    bucket.push(alias)
    aliasesById.set(emojiId, bucket)
  }

  return Object.values(data.emojis || {})
    .map((emoji) => {
      const native = emoji.skins?.[0]?.native
      if (!native) return null

      const aliases = aliasesById.get(emoji.id) || []
      const popularity = POPULAR_EMOJI_IDS.indexOf(emoji.id)

      return {
        id: emoji.id,
        native,
        label: `:${emoji.id}:`,
        description: emoji.name,
        aliases,
        emoticons: emoji.emoticons || [],
        popularity: popularity === -1 ? Number.MAX_SAFE_INTEGER : popularity,
        searchTerms: buildEmojiSearchTerms(emoji, aliases),
      } satisfies EmojiIndexEntry
    })
    .filter((emoji): emoji is EmojiIndexEntry => Boolean(emoji))
}

async function loadEmojiIndex() {
  if (!emojiIndexPromise) {
    emojiIndexPromise = import("@emoji-mart/data").then((mod) =>
      buildEmojiIndex((mod.default || mod) as EmojiMartData)
    )
  }

  return emojiIndexPromise
}

function scoreEmojiMatch(emoji: EmojiIndexEntry, query: string) {
  if (!query) {
    return emoji.popularity
  }

  const shortcodeMatch = [emoji.id, ...emoji.aliases].find(
    (term) => term === query
  )
  if (shortcodeMatch) return -10_000

  const shortcodePrefixMatch = [emoji.id, ...emoji.aliases].find((term) =>
    term.startsWith(query)
  )
  if (shortcodePrefixMatch) return -9_000

  const emoticonMatch = emoji.emoticons.find((term) => term === query)
  if (emoticonMatch) return -8_000

  const searchTermPrefixMatch = emoji.searchTerms.find((term) =>
    term.startsWith(query)
  )
  if (searchTermPrefixMatch) return -7_000

  const substringMatch = emoji.searchTerms.find((term) => term.includes(query))
  if (substringMatch) return -6_000

  return Number.POSITIVE_INFINITY
}

export async function searchEmojiSuggestions(query: string, limit = 12) {
  const normalizedQuery = normalizeQuery(query)
  const emojiIndex = await loadEmojiIndex()

  return emojiIndex
    .map((emoji) => ({
      emoji,
      score: scoreEmojiMatch(emoji, normalizedQuery),
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => {
      if (left.score !== right.score) return left.score - right.score
      if (left.emoji.popularity !== right.emoji.popularity) {
        return left.emoji.popularity - right.emoji.popularity
      }
      return left.emoji.id.localeCompare(right.emoji.id)
    })
    .slice(0, limit)
    .map((entry) => ({
      id: entry.emoji.id,
      native: entry.emoji.native,
      label: entry.emoji.label,
      description: entry.emoji.description,
      searchTerms: entry.emoji.searchTerms,
    }))
}
