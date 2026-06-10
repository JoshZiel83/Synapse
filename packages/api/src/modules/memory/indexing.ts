import crypto from "node:crypto"
import { extractText, type CanonicalContentBlock } from "@synapse/shared"
import { sql } from "kysely"
import {
  db,
  type TableInsert,
  withDbTransaction,
} from "../../infrastructure/database/kysely.js"
import { config } from "../../config/index.js"
import { itemPartsToCanonicalContentBlocks } from "../chat/message-content.js"
import { embedMemoryPassages } from "./embedding-runtime.js"
import { memoryIndexingQueue } from "../../workers/queues.js"
import { hashMemoryEmbeddingText } from "./embedding-input.js"

const MEMORY_VECTOR_DIMENSIONS = 384
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

function formatEmbeddingVector(values: number[]) {
  return `[${values.map((value) => (Number.isFinite(value) ? value.toFixed(8) : "0")).join(",")}]`
}

function parseEmbeddingVector(value: string | null | undefined) {
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

async function loadCachedPassageEmbeddings(searchTexts: string[]) {
  const hashes = Array.from(
    new Set(searchTexts.map((text) => hashMemoryEmbeddingText(text, "passage")))
  )
  if (hashes.length === 0) return new Map<string, number[]>()

  const rows = await db
    .selectFrom("memoryEmbeddingCache")
    .select(["contentHash", sql<string>`embedding::text`.as("embeddingText")])
    .where("modelId", "=", config.memory.modelId)
    .where("inputType", "=", "passage")
    .where("contentHash", "in", hashes)
    .execute()

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
  entries: Array<{ searchText: string; embedding: number[] }>
) {
  if (entries.length === 0) return

  await withDbTransaction(async (trx) => {
    for (const entry of entries) {
      if (entry.embedding.length === 0) continue
      const contentHash = hashMemoryEmbeddingText(entry.searchText, "passage")
      await trx
        .insertInto("memoryEmbeddingCache")
        .values({
          modelId: config.memory.modelId,
          inputType: "passage",
          contentHash: contentHash,
          embedding: sql`${formatEmbeddingVector(entry.embedding)}::vector`,
          embeddingDim: entry.embedding.length,
          createdAt: sql`NOW()`,
        })
        .onConflict((oc) =>
          oc.columns(["modelId", "inputType", "contentHash"]).doUpdateSet({
            embedding: sql`${formatEmbeddingVector(entry.embedding)}::vector`,
            embeddingDim: entry.embedding.length,
          })
        )
        .execute()
    }
  })
}

async function embedPassageBatchWithCache(
  batch: Array<{ id: string; searchText: string }>
) {
  const cached = await loadCachedPassageEmbeddings(
    batch.map((chunk) => chunk.searchText)
  )
  const embeddings: Array<number[] | null> = Array.from(
    { length: batch.length },
    () => null
  )
  const missing: Array<{ index: number; searchText: string }> = []

  for (let index = 0; index < batch.length; index += 1) {
    const contentHash = hashMemoryEmbeddingText(
      batch[index].searchText,
      "passage"
    )
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
    const computed = await embedMemoryPassages(
      missing.map((entry) => entry.searchText)
    )
    const newCacheEntries: Array<{ searchText: string; embedding: number[] }> =
      []
    for (let index = 0; index < missing.length; index += 1) {
      const missingEntry = missing[index]
      const embedding = computed[index] || []
      embeddings[missingEntry.index] = embedding
      if (embedding.length > 0) {
        newCacheEntries.push({
          searchText: missingEntry.searchText,
          embedding,
        })
      }
    }
    await upsertCachedPassageEmbeddings(newCacheEntries)
  }

  return embeddings.map((embedding) => embedding || [])
}

async function loadMemoryItemIndexSource(memoryItemId: string) {
  const item = await db
    .selectFrom("memoryItems as mi")
    .selectAll("mi")
    .where("mi.id", "=", memoryItemId)
    .limit(1)
    .executeTakeFirst()
  if (!item) return null

  const partsResult = await db
    .selectFrom("memoryItemParts as mip")
    .select([
      "mip.id",
      "mip.memoryItemId",
      "mip.ordinal",
      "mip.partType",
      "mip.textValue",
      "mip.refPath",
      "mip.refSha256",
      "mip.jsonValue",
      "mip.mimeType",
      "mip.name",
      "mip.metadata",
    ])
    .where("mip.memoryItemId", "=", memoryItemId)
    .orderBy("mip.ordinal", "asc")
    .execute()

  const contentBlocks = itemPartsToCanonicalContentBlocks(partsResult)
  return { item, contentBlocks }
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

  await withDbTransaction(async (trx) => {
    if (currentStagedVersion > 0) {
      // Index churn: route the physical delete through the SECURITY DEFINER fn
      // (sd_reject_delete forbids a naked DELETE on this persistent child table).
      await sql`SELECT sd_replace_memory_item_chunks(${memoryItemId}::uuid, ${currentStagedVersion}::int)`.execute(
        trx
      )
    }

    for (const spec of specs) {
      await trx
        .insertInto("memoryItemChunks")
        .values({
          id: crypto.randomUUID(),
          memoryItemId: memoryItemId,
          workspaceId: source.item.workspaceId,
          indexVersion: nextIndexVersion,
          chunkIndex: spec.chunkIndex,
          chunkKind: spec.chunkKind,
          searchText: spec.searchText,
          embedding: null,
          tokenCount: Math.ceil(spec.searchText.length / 4),
          metadata: {
            textDigest: source.item.textDigest,
            state: source.item.state,
          } as TableInsert<"memoryItemChunks">["metadata"],
          createdAt: sql`NOW()`,
        })
        .execute()
    }

    await trx
      .updateTable("memoryItems")
      .set({
        searchText: searchText,
        indexStatus: "lexical_ready",
        activeIndexVersion: nextActiveVersion,
        stagedIndexVersion: nextStagedVersion,
        embeddingModel: "",
        embeddingDim: null,
        indexedAt: null,
        indexError: null,
      })
      .where("id", "=", memoryItemId)
      .execute()
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
  const item = await db
    .selectFrom("memoryItems")
    .select(["id", "activeIndexVersion", "stagedIndexVersion"])
    .where("id", "=", memoryItemId)
    .limit(1)
    .executeTakeFirst()
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

  const chunks = await db
    .selectFrom("memoryItemChunks")
    .select(["id", "searchText", "indexVersion"])
    .where("memoryItemId", "=", memoryItemId)
    .where("indexVersion", "=", targetIndexVersion)
    .orderBy("chunkIndex", "asc")
    .execute()

  if (chunks.length === 0) {
    await withDbTransaction(async (trx) => {
      await trx
        .updateTable("memoryItems")
        .set({
          activeIndexVersion: targetIndexVersion,
          stagedIndexVersion: null,
          indexStatus: "ready",
          embeddingModel: config.memory.modelId,
          embeddingDim: MEMORY_VECTOR_DIMENSIONS,
          indexedAt: sql`NOW()`,
          indexError: null,
        })
        .where("id", "=", memoryItemId)
        .execute()

      if (
        stagedIndexVersion > 0 &&
        activeIndexVersion > 0 &&
        activeIndexVersion !== targetIndexVersion
      ) {
        await sql`SELECT sd_replace_memory_item_chunks(${memoryItemId}::uuid, ${activeIndexVersion}::int)`.execute(
          trx
        )
      }
    })
    return { status: "ready" as const, chunkCount: 0 }
  }

  try {
    for (const batch of chunkBatches(
      chunks,
      Math.max(1, config.memory.embedBatchSize)
    )) {
      const embeddings = await embedPassageBatchWithCache(batch)
      for (let index = 0; index < batch.length; index += 1) {
        const chunk = batch[index]
        const embedding = embeddings[index]
        await db
          .updateTable("memoryItemChunks")
          .set({
            embedding:
              embedding && embedding.length > 0
                ? sql`${formatEmbeddingVector(embedding)}::vector`
                : null,
          })
          .where("id", "=", chunk.id)
          .where("indexVersion", "=", targetIndexVersion)
          .execute()
      }
    }

    await withDbTransaction(async (trx) => {
      await trx
        .updateTable("memoryItems")
        .set({
          activeIndexVersion: targetIndexVersion,
          stagedIndexVersion: null,
          indexStatus: "ready",
          embeddingModel: config.memory.modelId,
          embeddingDim: MEMORY_VECTOR_DIMENSIONS,
          indexedAt: sql`NOW()`,
          indexError: null,
        })
        .where("id", "=", memoryItemId)
        .execute()

      if (
        stagedIndexVersion > 0 &&
        activeIndexVersion > 0 &&
        activeIndexVersion !== targetIndexVersion
      ) {
        await sql`SELECT sd_replace_memory_item_chunks(${memoryItemId}::uuid, ${activeIndexVersion}::int)`.execute(
          trx
        )
      }
    })

    return {
      status: "ready" as const,
      chunkCount: chunks.length,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await db
      .updateTable("memoryItems")
      .set({
        indexStatus: "failed",
        embeddingModel: config.memory.modelId,
        embeddingDim: MEMORY_VECTOR_DIMENSIONS,
        indexError: message,
      })
      .where("id", "=", memoryItemId)
      .execute()
    return {
      status: "failed" as const,
      error: message,
    }
  }
}
