import { extractText, type CanonicalContentBlock } from '@synapse/shared';
import {
  db,
  type TableInsert,
} from '../../infrastructure/database/kysely.js';
import { config } from '../../config/index.js';
import { itemPartsToCanonicalContentBlocks } from '../conversation/message-content.js';
import { sql } from 'kysely';

const MEMORY_VECTOR_DIMENSIONS = 1536;
let hasWarnedAboutEmbeddingDimensions = false;

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

  return sections.join('\n').trim();
}

export function chunkMemorySearchText(text: string, options?: { maxChars?: number; overlapChars?: number }) {
  const normalized = text.trim();
  if (!normalized) return [];

  const maxChars = options?.maxChars ?? 1200;
  const overlapChars = options?.overlapChars ?? 160;
  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < normalized.length) {
    const end = Math.min(normalized.length, cursor + maxChars);
    const chunk = normalized.slice(cursor, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    cursor = Math.max(end - overlapChars, cursor + 1);
  }

  return chunks;
}

function canGenerateEmbeddings() {
  return !!(config.memory.embeddings.apiKey && config.memory.embeddings.baseUrl && config.memory.embeddings.model);
}

function formatEmbeddingVector(values: number[]) {
  return `[${values.map((value) => Number.isFinite(value) ? value.toFixed(8) : '0').join(',')}]`;
}

async function embedTexts(texts: string[]) {
  if (texts.length === 0 || !canGenerateEmbeddings()) return null;

  if (config.memory.embeddings.dimensions !== MEMORY_VECTOR_DIMENSIONS) {
    if (!hasWarnedAboutEmbeddingDimensions) {
      hasWarnedAboutEmbeddingDimensions = true;
      console.warn(
        `[memory] MEMORY_EMBEDDINGS_DIMENSIONS=${config.memory.embeddings.dimensions} does not match schema dimension ${MEMORY_VECTOR_DIMENSIONS}; vector recall disabled.`,
      );
    }
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.memory.embeddings.timeoutMs);
  const baseUrl = config.memory.embeddings.baseUrl.replace(/\/+$/, '');

  try {
    const response = await fetch(`${baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.memory.embeddings.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.memory.embeddings.model,
        input: texts,
        dimensions: config.memory.embeddings.dimensions,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[memory] embedding request failed:', response.status, errorText);
      return null;
    }

    const data = await response.json() as { data?: Array<{ embedding: number[] }> };
    if (!Array.isArray(data.data)) return null;
    return data.data.map((item) => item.embedding);
  } catch (error) {
    console.error('[memory] failed to generate embeddings:', error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadMemoryEntryIndexSource(memoryEntryId: string) {
  const entry = await db
    .selectFrom('memory_entries as me')
    .selectAll('me')
    .where('me.id', '=', memoryEntryId)
    .limit(1)
    .executeTakeFirst();
  if (!entry) return null;

  const partsResult = await db
    .selectFrom('memory_entry_parts as mep')
    .leftJoin('files as f', 'f.id', 'mep.file_id')
    .select([
      'mep.id',
      'mep.memory_entry_id',
      'mep.ordinal',
      'mep.part_type',
      'mep.text_value',
      'mep.file_id',
      'mep.json_value',
      'mep.mime_type',
      'mep.name',
      'mep.metadata',
      'f.original_name',
      'f.stored_name',
      'f.mime_type as file_mime_type',
      'f.size_bytes',
    ])
    .where('mep.memory_entry_id', '=', memoryEntryId)
    .orderBy('mep.ordinal', 'asc')
    .execute();

  const contentBlocks = itemPartsToCanonicalContentBlocks(partsResult);
  return { entry, contentBlocks };
}

export async function reindexMemoryEntry(memoryEntryId: string) {
  const source = await loadMemoryEntryIndexSource(memoryEntryId);
  if (!source) return;

  const searchText = buildMemorySearchText({
    contentBlocks: source.contentBlocks,
    textDigest: source.entry.text_digest,
    tags: source.entry.tags || [],
    category: source.entry.category,
  });
  const chunks = chunkMemorySearchText(searchText);
  const embeddings = await embedTexts(chunks);

  await db
    .deleteFrom('memory_index_chunks')
    .where('memory_entry_id', '=', memoryEntryId)
    .execute();

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    await db
      .insertInto('memory_index_chunks')
      .values({
        memory_entry_id: memoryEntryId,
        workspace_id: source.entry.workspace_id,
        owner_scope: source.entry.owner_scope,
        owner_actor_id: source.entry.owner_actor_id,
        owner_conversation_id: source.entry.owner_conversation_id,
        owner_user_id: source.entry.owner_user_id,
        chunk_index: index,
        search_text: chunk,
        embedding: embeddings?.[index]
          ? sql`${formatEmbeddingVector(embeddings[index])}::vector`
          : null,
        token_count: Math.ceil(chunk.length / 4),
        metadata: {
          textDigest: source.entry.text_digest,
          status: source.entry.status,
          stability: source.entry.stability,
        } as TableInsert<'memory_index_chunks'>['metadata'],
        created_at: sql`NOW()`,
        updated_at: sql`NOW()`,
      })
      .execute();
  }
}
