import { extractText, type CanonicalContentBlock } from "@synapse/shared"
import { config } from "../../config/index.js"
import { itemPartsToCanonicalContentBlocks } from "../chat/message-content.js"
import { embedPassages, resolveEmbeddingProvider } from "../embedding/index.js"
import { memoryIndexingQueue } from "../../workers/queues.js"
import { hashMemoryEmbeddingText } from "./embedding-input.js"
import { formatEmbeddingVector, parseEmbeddingVector } from "./vector-codec.js"
import {
  commitMemoryItemIndexOutcome,
  commitMemoryItemLexicalRebuild,
  loadMemoryItemChunksForVersion,
  loadMemoryItemIndexSourceRows,
  loadMemoryItemIndexVersions,
  loadMemoryPassageEmbeddingCacheRows,
  setMemoryItemChunkEmbedding,
  upsertMemoryPassageEmbeddingCache,
} from "./repo.js"

const TARGET_CHUNK_CHARS = 800
const HARD_MAX_CHUNK_CHARS = 1000
const CHUNK_OVERLAP_CHARS = 120

type MemoryChunkSpec = {
  chunkIndex: number
  chunkKind: "digest" | "body"
  searchText: string
}

function summarizeFileBlocks(blocks: CanonicalContentBlock[]) {
  return blocks
    .filter(
      (block): block is Extract<CanonicalContentBlock, { type: "file_ref" }> =>
        block.type === "file_ref"
    )
    .map((block) => `${block.category}:${block.name}`)
    .join("\n")
}

export function buildMemoryTextDigest(params: {
  contentBlocks: CanonicalContentBlock[]
  fallbackText?: string
}) {
  const text = extractText(params.contentBlocks).trim()
  if (text) {
    return text.length > 500 ? `${text.slice(0, 497)}...` : text
  }

  const fileSummary = summarizeFileBlocks(params.contentBlocks)
  if (fileSummary) {
    return fileSummary.length > 500
      ? `${fileSummary.slice(0, 497)}...`
      : fileSummary
  }

  return (params.fallbackText || "").trim()
}

export function buildMemorySearchText(params: {
  contentBlocks: CanonicalContentBlock[]
  textDigest?: string
  tags?: string[]
  category?: string
}) {
  const textBlocks = extractText(params.contentBlocks).trim()
  const fileSummary = summarizeFileBlocks(params.contentBlocks)
  const sections = [
    params.textDigest?.trim() || "",
    textBlocks,
    fileSummary,
    params.category ? `category:${params.category}` : "",
    params.tags && params.tags.length > 0
      ? `tags:${params.tags.join(", ")}`
      : "",
  ].filter(Boolean)

  return sections.join("\n\n").trim()
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function sentenceSplit(text: string) {
  const sentences = text.match(/[^.!?。！？\n]+[.!?。！？]?/g)
  if (!sentences) return [text]
  return sentences.map((sentence) => sentence.trim()).filter(Boolean)
}

function sliceLongText(text: string) {
  const normalized = normalizeWhitespace(text)
  if (!normalized) return []

  const chunks: string[] = []
  let cursor = 0
  while (cursor < normalized.length) {
    const end = Math.min(normalized.length, cursor + HARD_MAX_CHUNK_CHARS)
    const chunk = normalized.slice(cursor, end).trim()
    if (chunk) chunks.push(chunk)
    if (end >= normalized.length) break
    cursor = Math.max(end - CHUNK_OVERLAP_CHARS, cursor + 1)
  }

  return chunks
}

export function chunkMemorySearchText(text: string) {
  const normalized = text.trim()
  if (!normalized) return []

  const paragraphs = normalized
    .split(/\n{2,}/g)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
  const chunks: string[] = []
  let current = ""

  const flush = () => {
    const next = normalizeWhitespace(current)
    if (next) chunks.push(next)
    current = ""
  }

  for (const paragraph of paragraphs) {
    const paragraphText = normalizeWhitespace(paragraph)
    if (!paragraphText) continue

    if (paragraphText.length > HARD_MAX_CHUNK_CHARS) {
      if (current) flush()
      const sentences = sentenceSplit(paragraphText)
      let sentenceChunk = ""
      for (const sentence of sentences) {
        if (sentence.length > HARD_MAX_CHUNK_CHARS) {
          if (sentenceChunk) {
            current = sentenceChunk
            flush()
            sentenceChunk = ""
          }
          chunks.push(...sliceLongText(sentence))
          continue
        }

        const next = sentenceChunk ? `${sentenceChunk} ${sentence}` : sentence
        if (next.length > TARGET_CHUNK_CHARS && sentenceChunk) {
          current = sentenceChunk
          flush()
          sentenceChunk = sentence
        } else {
          sentenceChunk = next
        }
      }
      if (sentenceChunk) {
        current = sentenceChunk
        flush()
      }
      continue
    }

    const candidate = current ? `${current}\n\n${paragraphText}` : paragraphText
    if (candidate.length > TARGET_CHUNK_CHARS && current) {
      flush()
      current = paragraphText
    } else {
      current = candidate
    }
  }

  if (current) flush()
  return chunks
}

function buildMemoryChunkSpecs(params: {
  contentBlocks: CanonicalContentBlock[]
  textDigest: string
  tags?: string[]
  category?: string
}) {
  const digestChunk = normalizeWhitespace(
    [
      params.textDigest,
      params.category ? `category:${params.category}` : "",
      params.tags && params.tags.length > 0
        ? `tags:${params.tags.join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n")
  )

  const bodyText = buildMemorySearchText(params)
  const bodyChunks = chunkMemorySearchText(bodyText)

  const specs: MemoryChunkSpec[] = []
  const seen = new Set<string>()

  if (digestChunk) {
    seen.add(digestChunk)
    specs.push({
      chunkIndex: specs.length,
      chunkKind: "digest",
      searchText: digestChunk,
    })
  }

  for (const chunk of bodyChunks) {
    if (seen.has(chunk)) continue
    seen.add(chunk)
    specs.push({
      chunkIndex: specs.length,
      chunkKind: "body",
      searchText: chunk,
    })
  }

  return specs
}

async function loadCachedPassageEmbeddings(
  searchTexts: string[],
  engineVersion: string
) {
  const hashes = Array.from(
    new Set(searchTexts.map((text) => hashMemoryEmbeddingText(text)))
  )
  if (hashes.length === 0) return new Map<string, number[]>()

  const rows = await loadMemoryPassageEmbeddingCacheRows(hashes, engineVersion)

  const cache = new Map<string, number[]>()
  for (const row of rows) {
    const embedding = parseEmbeddingVector(row.embeddingText)
    if (embedding && embedding.length > 0) {
      cache.set(row.contentHash, embedding)
    }
  }
  return cache
}

async function upsertCachedPassageEmbeddings(
  entries: Array<{ searchText: string; embedding: number[] }>,
  engineVersion: string
) {
  if (entries.length === 0) return

  const rows = entries
    .filter((entry) => entry.embedding.length > 0)
    .map((entry) => ({
      contentHash: hashMemoryEmbeddingText(entry.searchText),
      embeddingLiteral: formatEmbeddingVector(entry.embedding),
      embeddingDim: entry.embedding.length,
    }))

  await upsertMemoryPassageEmbeddingCache(rows, engineVersion)
}

type BatchEmbedResult =
  | { ok: true; embeddings: number[][] }
  | { ok: false; retryable: boolean; error: string }

/** Embed one chunk batch, serving hits from the Postgres passage cache and calling
 *  the embedding facade only for misses. Propagates the facade's ok/retryable so
 *  the caller (reindexMemoryItemEmbeddings) can classify — a transient failure must
 *  NOT be written as a NULL/garbage vector. Cache entries are keyed by the active
 *  provider's engineVersion. */
async function embedPassageBatchWithCache(
  batch: Array<{ id: string; searchText: string }>,
  engineVersion: string
): Promise<BatchEmbedResult> {
  const cached = await loadCachedPassageEmbeddings(
    batch.map((chunk) => chunk.searchText),
    engineVersion
  )
  const embeddings: Array<number[] | null> = Array.from(
    { length: batch.length },
    () => null
  )
  const missing: Array<{ index: number; searchText: string }> = []

  for (let index = 0; index < batch.length; index += 1) {
    const contentHash = hashMemoryEmbeddingText(batch[index].searchText)
    const embedding = cached.get(contentHash)
    if (embedding && embedding.length > 0) {
      embeddings[index] = embedding
    } else {
      missing.push({
        index,
        searchText: batch[index].searchText,
      })
    }
  }

  if (missing.length > 0) {
    const result = await embedPassages(missing.map((entry) => entry.searchText))
    if (!result.ok) {
      return {
        ok: false,
        retryable: result.retryable ?? true,
        error: result.error ?? "embedding failed",
      }
    }
    const newCacheEntries: Array<{ searchText: string; embedding: number[] }> =
      []
    for (let index = 0; index < missing.length; index += 1) {
      const missingEntry = missing[index]
      const embedding = result.vectors[index] || []
      embeddings[missingEntry.index] = embedding
      if (embedding.length > 0) {
        newCacheEntries.push({
          searchText: missingEntry.searchText,
          embedding,
        })
      }
    }
    await upsertCachedPassageEmbeddings(newCacheEntries, engineVersion)
  }

  return {
    ok: true,
    embeddings: embeddings.map((embedding) => embedding || []),
  }
}

async function loadMemoryItemIndexSource(memoryItemId: string) {
  const source = await loadMemoryItemIndexSourceRows(memoryItemId)
  if (!source) return null

  const contentBlocks = itemPartsToCanonicalContentBlocks(source.parts)
  return { item: source.item, contentBlocks }
}

export async function rebuildMemoryItemLexicalIndex(memoryItemId: string) {
  const source = await loadMemoryItemIndexSource(memoryItemId)
  if (!source) return null

  const searchText = buildMemorySearchText({
    contentBlocks: source.contentBlocks,
    textDigest: source.item.textDigest,
    tags: source.item.tags || [],
    category: source.item.category,
  })
  const specs = buildMemoryChunkSpecs({
    contentBlocks: source.contentBlocks,
    textDigest: source.item.textDigest,
    tags: source.item.tags || [],
    category: source.item.category,
  })
  const currentActiveVersion = Number(source.item.activeIndexVersion || 0)
  const currentStagedVersion = Number(source.item.stagedIndexVersion || 0)
  const nextIndexVersion =
    Math.max(currentActiveVersion, currentStagedVersion) + 1
  const shouldStageNextVersion = currentActiveVersion > 0
  const nextActiveVersion = shouldStageNextVersion
    ? currentActiveVersion
    : nextIndexVersion
  const nextStagedVersion = shouldStageNextVersion ? nextIndexVersion : null

  await commitMemoryItemLexicalRebuild({
    memoryItemId,
    workspaceId: source.item.workspaceId,
    searchText,
    textDigest: source.item.textDigest,
    state: source.item.state,
    nextIndexVersion,
    nextActiveVersion,
    nextStagedVersion,
    currentStagedVersion,
    specs,
  })

  return {
    indexVersion: nextIndexVersion,
    chunkCount: specs.length,
  }
}

export async function queueMemoryItemEmbeddingIndex(
  memoryItemId: string,
  indexVersion: number
) {
  await memoryIndexingQueue.add(
    "index",
    {
      memoryItemId,
      indexVersion,
    },
    {
      jobId: `memory-index-${memoryItemId}-${indexVersion}`,
    }
  )
}

function chunkBatches<T>(items: T[], size: number) {
  const batches: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size))
  }
  return batches
}

export async function reindexMemoryItemEmbeddings(
  memoryItemId: string,
  expectedIndexVersion?: number
) {
  const item = await loadMemoryItemIndexVersions(memoryItemId)
  if (!item) return { status: "missing" as const }

  const activeIndexVersion = Number(item.activeIndexVersion || 0)
  const stagedIndexVersion = Number(item.stagedIndexVersion || 0)
  const targetIndexVersion =
    stagedIndexVersion > 0 ? stagedIndexVersion : activeIndexVersion

  if (targetIndexVersion <= 0) {
    return { status: "missing" as const }
  }
  if (
    expectedIndexVersion !== undefined &&
    targetIndexVersion !== expectedIndexVersion
  ) {
    return { status: "stale" as const }
  }

  const provider = resolveEmbeddingProvider()
  const chunks = await loadMemoryItemChunksForVersion(
    memoryItemId,
    targetIndexVersion
  )

  // Provider disabled (none) or nothing to embed → promote the staged version with
  // NO embeddings and stay lexical_ready (semantic arm intentionally off). This is
  // NOT a failure: recall degrades to lexical. `lexical_ready`+NULL is reserved
  // strictly for provider=none so a CONFIGURED provider's error stays queryable.
  if (provider.key === "none" || chunks.length === 0) {
    const disabled = provider.key === "none"
    await commitMemoryItemIndexOutcome({
      memoryItemId,
      targetIndexVersion,
      activeIndexVersion,
      stagedIndexVersion,
      embeddingModel: disabled ? "" : provider.engineVersion,
      embeddingDim: disabled ? null : provider.dimension,
      indexStatus: disabled ? "lexical_ready" : "ready",
    })
    return {
      status: "ready" as const,
      chunkCount: chunks.length,
      semanticDisabled: disabled,
    }
  }

  const writes: Array<{ id: string; literal: string | null }> = []
  for (const batch of chunkBatches(
    chunks,
    Math.max(1, config.embedding.batchSize)
  )) {
    const batchResult = await embedPassageBatchWithCache(
      batch,
      provider.engineVersion
    )
    if (!batchResult.ok) {
      // Transient (sidecar down / 503 / 5xx / 429) → throw so BullMQ retries
      // (MEMORY_INDEXING_JOB_DEFAULTS: attempts 5). Leave the item lexical_ready —
      // no premature 'failed'.
      if (batchResult.retryable) {
        throw new Error(
          `memory embedding failed (retryable): ${batchResult.error}`
        )
      }
      // Terminal for a CONFIGURED provider (4xx wrong model/key/param) → record
      // failed + index_error (queryable/alertable) and stop; retrying won't help.
      // Still PROMOTE the staged version (with no embeddings) so recall serves the
      // edited lexical content instead of freezing on the stale prior version.
      await commitMemoryItemIndexOutcome({
        memoryItemId,
        targetIndexVersion,
        activeIndexVersion,
        stagedIndexVersion,
        indexStatus: "failed",
        embeddingModel: provider.engineVersion,
        embeddingDim: provider.dimension,
        indexError: batchResult.error,
      })
      return { status: "failed" as const, error: batchResult.error }
    }
    for (let index = 0; index < batch.length; index += 1) {
      const embedding = batchResult.embeddings[index]
      writes.push({
        id: batch[index].id,
        literal: embedding.length > 0 ? formatEmbeddingVector(embedding) : null,
      })
    }
  }

  for (const write of writes) {
    await setMemoryItemChunkEmbedding(
      write.id,
      targetIndexVersion,
      write.literal
    )
  }

  await commitMemoryItemIndexOutcome({
    memoryItemId,
    targetIndexVersion,
    activeIndexVersion,
    stagedIndexVersion,
    indexStatus: "ready",
    embeddingModel: provider.engineVersion,
    embeddingDim: provider.dimension,
  })

  return {
    status: "ready" as const,
    chunkCount: chunks.length,
  }
}
