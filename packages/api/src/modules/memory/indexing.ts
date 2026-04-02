import crypto from 'node:crypto';
import { extractText, type CanonicalContentBlock } from '@synapse/shared';
import { sql } from 'kysely';
import {
  db,
  type TableInsert,
} from '../../infrastructure/database/kysely.js';
import { config } from '../../config/index.js';
import { itemPartsToCanonicalContentBlocks } from '../conversation/message-content.js';
import { embedMemoryPassages } from './embedding-runtime.js';
import { memoryIndexingQueue } from '../../workers/queues.js';

const MEMORY_VECTOR_DIMENSIONS = 384;
const TARGET_CHUNK_CHARS = 800;
const HARD_MAX_CHUNK_CHARS = 1000;
const CHUNK_OVERLAP_CHARS = 120;

type MemoryChunkSpec = {
  chunkIndex: number;
  chunkKind: 'digest' | 'body';
  searchText: string;
};

function summarizeFileBlocks(blocks: CanonicalContentBlock[]) {
  return blocks
    .filter((block): block is Extract<CanonicalContentBlock, { type: 'file_ref' }> => block.type === 'file_ref')
    .map((block) => `${block.category}:${block.originalName}`)
    .join('\n');
}

export function buildMemoryTextDigest(params: {
  contentBlocks: CanonicalContentBlock[];
  fallbackText?: string;
}) {
  const text = extractText(params.contentBlocks).trim();
  if (text) {
    return text.length > 500 ? `${text.slice(0, 497)}...` : text;
  }

  const fileSummary = summarizeFileBlocks(params.contentBlocks);
  if (fileSummary) {
    return fileSummary.length > 500 ? `${fileSummary.slice(0, 497)}...` : fileSummary;
  }

  return (params.fallbackText || '').trim();
}

export function buildMemorySearchText(params: {
  contentBlocks: CanonicalContentBlock[];
  textDigest?: string;
  tags?: string[];
  category?: string;
}) {
  const textBlocks = extractText(params.contentBlocks).trim();
  const fileSummary = summarizeFileBlocks(params.contentBlocks);
  const sections = [
    params.textDigest?.trim() || '',
    textBlocks,
    fileSummary,
    params.category ? `category:${params.category}` : '',
    params.tags && params.tags.length > 0 ? `tags:${params.tags.join(', ')}` : '',
  ].filter(Boolean);

  return sections.join('\n\n').trim();
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function sentenceSplit(text: string) {
  const sentences = text.match(/[^.!?。！？\n]+[.!?。！？]?/g);
  if (!sentences) return [text];
  return sentences.map((sentence) => sentence.trim()).filter(Boolean);
}

function sliceLongText(text: string) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return [];

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    const end = Math.min(normalized.length, cursor + HARD_MAX_CHUNK_CHARS);
    const chunk = normalized.slice(cursor, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    cursor = Math.max(end - CHUNK_OVERLAP_CHARS, cursor + 1);
  }

  return chunks;
}

export function chunkMemorySearchText(text: string) {
  const normalized = text.trim();
  if (!normalized) return [];

  const paragraphs = normalized
    .split(/\n{2,}/g)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    const next = normalizeWhitespace(current);
    if (next) chunks.push(next);
    current = '';
  };

  for (const paragraph of paragraphs) {
    const paragraphText = normalizeWhitespace(paragraph);
    if (!paragraphText) continue;

    if (paragraphText.length > HARD_MAX_CHUNK_CHARS) {
      if (current) flush();
      const sentences = sentenceSplit(paragraphText);
      let sentenceChunk = '';
      for (const sentence of sentences) {
        if (sentence.length > HARD_MAX_CHUNK_CHARS) {
          if (sentenceChunk) {
            current = sentenceChunk;
            flush();
            sentenceChunk = '';
          }
          chunks.push(...sliceLongText(sentence));
          continue;
        }

        const next = sentenceChunk ? `${sentenceChunk} ${sentence}` : sentence;
        if (next.length > TARGET_CHUNK_CHARS && sentenceChunk) {
          current = sentenceChunk;
          flush();
          sentenceChunk = sentence;
        } else {
          sentenceChunk = next;
        }
      }
      if (sentenceChunk) {
        current = sentenceChunk;
        flush();
      }
      continue;
    }

    const candidate = current ? `${current}\n\n${paragraphText}` : paragraphText;
    if (candidate.length > TARGET_CHUNK_CHARS && current) {
      flush();
      current = paragraphText;
    } else {
      current = candidate;
    }
  }

  if (current) flush();
  return chunks;
}

function buildMemoryChunkSpecs(params: {
  contentBlocks: CanonicalContentBlock[];
  textDigest: string;
  tags?: string[];
  category?: string;
}) {
  const digestChunk = normalizeWhitespace([
    params.textDigest,
    params.category ? `category:${params.category}` : '',
    params.tags && params.tags.length > 0 ? `tags:${params.tags.join(', ')}` : '',
  ].filter(Boolean).join('\n'));

  const bodyText = buildMemorySearchText(params);
  const bodyChunks = chunkMemorySearchText(bodyText);

  const specs: MemoryChunkSpec[] = [];
  const seen = new Set<string>();

  if (digestChunk) {
    seen.add(digestChunk);
    specs.push({
      chunkIndex: specs.length,
      chunkKind: 'digest',
      searchText: digestChunk,
    });
  }

  for (const chunk of bodyChunks) {
    if (seen.has(chunk)) continue;
    seen.add(chunk);
    specs.push({
      chunkIndex: specs.length,
      chunkKind: 'body',
      searchText: chunk,
    });
  }

  return specs;
}

function formatEmbeddingVector(values: number[]) {
  return `[${values.map((value) => Number.isFinite(value) ? value.toFixed(8) : '0').join(',')}]`;
}

async function loadMemoryItemIndexSource(memoryItemId: string) {
  const item = await db
    .selectFrom('memory_items as mi')
    .selectAll('mi')
    .where('mi.id', '=', memoryItemId)
    .limit(1)
    .executeTakeFirst();
  if (!item) return null;

  const partsResult = await db
    .selectFrom('memory_item_parts as mip')
    .leftJoin('files as f', 'f.id', 'mip.file_id')
    .select([
      'mip.id',
      'mip.memory_item_id',
      'mip.ordinal',
      'mip.part_type',
      'mip.text_value',
      'mip.file_id',
      'mip.json_value',
      'mip.mime_type',
      'mip.name',
      'mip.metadata',
      'f.original_name',
      'f.stored_name',
      'f.mime_type as file_mime_type',
      'f.size_bytes',
    ])
    .where('mip.memory_item_id', '=', memoryItemId)
    .orderBy('mip.ordinal', 'asc')
    .execute();

  const contentBlocks = itemPartsToCanonicalContentBlocks(partsResult);
  return { item, contentBlocks };
}

export async function rebuildMemoryItemLexicalIndex(memoryItemId: string) {
  const source = await loadMemoryItemIndexSource(memoryItemId);
  if (!source) return null;

  const searchText = buildMemorySearchText({
    contentBlocks: source.contentBlocks,
    textDigest: source.item.text_digest,
    tags: source.item.tags || [],
    category: source.item.category,
  });
  const specs = buildMemoryChunkSpecs({
    contentBlocks: source.contentBlocks,
    textDigest: source.item.text_digest,
    tags: source.item.tags || [],
    category: source.item.category,
  });
  const nextIndexVersion = Number(source.item.index_version || 0) + 1;

  await db
    .deleteFrom('memory_item_chunks')
    .where('memory_item_id', '=', memoryItemId)
    .execute();

  for (const spec of specs) {
    await db
      .insertInto('memory_item_chunks')
      .values({
        id: crypto.randomUUID(),
        memory_item_id: memoryItemId,
        workspace_id: source.item.workspace_id,
        chunk_index: spec.chunkIndex,
        chunk_kind: spec.chunkKind,
        search_text: spec.searchText,
        embedding: null,
        token_count: Math.ceil(spec.searchText.length / 4),
        metadata: {
          textDigest: source.item.text_digest,
          state: source.item.state,
        } as TableInsert<'memory_item_chunks'>['metadata'],
        created_at: sql`NOW()`,
        updated_at: sql`NOW()`,
      })
      .execute();
  }

  await db
    .updateTable('memory_items')
    .set({
      search_text: searchText,
      index_status: 'lexical_ready',
      index_version: nextIndexVersion,
      embedding_model: '',
      embedding_dim: null,
      indexed_at: null,
      index_error: null,
      updated_at: sql`NOW()`,
    })
    .where('id', '=', memoryItemId)
    .execute();

  return {
    indexVersion: nextIndexVersion,
    chunkCount: specs.length,
  };
}

export async function queueMemoryItemEmbeddingIndex(memoryItemId: string, indexVersion: number) {
  await memoryIndexingQueue.add(
    'index',
    {
      memoryItemId,
      indexVersion,
    },
    {
      jobId: `memory-index-${memoryItemId}-${indexVersion}`,
    },
  );
}

function chunkBatches<T>(items: T[], size: number) {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

export async function reindexMemoryItemEmbeddings(memoryItemId: string, expectedIndexVersion?: number) {
  const item = await db
    .selectFrom('memory_items')
    .select([
      'id',
      'index_version',
    ])
    .where('id', '=', memoryItemId)
    .limit(1)
    .executeTakeFirst();
  if (!item) return { status: 'missing' as const };
  if (
    expectedIndexVersion !== undefined
    && Number(item.index_version || 0) !== expectedIndexVersion
  ) {
    return { status: 'stale' as const };
  }

  const chunks = await db
    .selectFrom('memory_item_chunks')
    .select(['id', 'search_text'])
    .where('memory_item_id', '=', memoryItemId)
    .orderBy('chunk_index', 'asc')
    .execute();

  if (chunks.length === 0) {
    await db
      .updateTable('memory_items')
      .set({
        index_status: 'ready',
        embedding_model: config.memory.modelId,
        embedding_dim: MEMORY_VECTOR_DIMENSIONS,
        indexed_at: sql`NOW()`,
        index_error: null,
        updated_at: sql`NOW()`,
      })
      .where('id', '=', memoryItemId)
      .execute();
    return { status: 'ready' as const, chunkCount: 0 };
  }

  try {
    for (const batch of chunkBatches(chunks, Math.max(1, config.memory.embedBatchSize))) {
      const embeddings = await embedMemoryPassages(batch.map((chunk) => chunk.search_text));
      for (let index = 0; index < batch.length; index += 1) {
        const chunk = batch[index];
        const embedding = embeddings[index];
        await db
          .updateTable('memory_item_chunks')
          .set({
            embedding: embedding
              ? sql`${formatEmbeddingVector(embedding)}::vector`
              : null,
            updated_at: sql`NOW()`,
          })
          .where('id', '=', chunk.id)
          .execute();
      }
    }

    await db
      .updateTable('memory_items')
      .set({
        index_status: 'ready',
        embedding_model: config.memory.modelId,
        embedding_dim: MEMORY_VECTOR_DIMENSIONS,
        indexed_at: sql`NOW()`,
        index_error: null,
        updated_at: sql`NOW()`,
      })
      .where('id', '=', memoryItemId)
      .execute();

    return {
      status: 'ready' as const,
      chunkCount: chunks.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .updateTable('memory_items')
      .set({
        index_status: 'failed',
        embedding_model: config.memory.modelId,
        embedding_dim: MEMORY_VECTOR_DIMENSIONS,
        index_error: message,
        updated_at: sql`NOW()`,
      })
      .where('id', '=', memoryItemId)
      .execute();
    return {
      status: 'failed' as const,
      error: message,
    };
  }
}
