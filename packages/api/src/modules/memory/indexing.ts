import { extractText, type CanonicalContentBlock } from '@synapse/shared';
import { query } from '../../infrastructure/database/index.js';
import { config } from '../../config/index.js';
import { itemPartsToCanonicalContentBlocks } from '../conversation/message-content.js';

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
  const entryResult = await query(
    `SELECT me.*
     FROM memory_entries me
     WHERE me.id = $1
     LIMIT 1`,
    [memoryEntryId],
  );
  const entry = entryResult.rows[0];
  if (!entry) return null;

  const partsResult = await query(
    `SELECT mep.*,
            f.original_name,
            f.stored_name,
            f.mime_type AS file_mime_type,
            f.size_bytes
     FROM memory_entry_parts mep
     LEFT JOIN files f ON f.id = mep.file_id
     WHERE mep.memory_entry_id = $1
     ORDER BY mep.ordinal ASC`,
    [memoryEntryId],
  );

  const contentBlocks = itemPartsToCanonicalContentBlocks(partsResult.rows);
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

  await query('DELETE FROM memory_index_chunks WHERE memory_entry_id = $1', [memoryEntryId]);

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    await query(
      `INSERT INTO memory_index_chunks
         (id, memory_entry_id, workspace_id, owner_scope, owner_actor_id, owner_conversation_id, owner_user_id, chunk_index, search_text, embedding, token_count, metadata, created_at, updated_at)
       VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10, $11, NOW(), NOW())`,
      [
        memoryEntryId,
        source.entry.workspace_id,
        source.entry.owner_scope,
        source.entry.owner_actor_id,
        source.entry.owner_conversation_id,
        source.entry.owner_user_id,
        index,
        chunk,
        embeddings?.[index] ? formatEmbeddingVector(embeddings[index]) : null,
        Math.ceil(chunk.length / 4),
        JSON.stringify({
          textDigest: source.entry.text_digest,
          status: source.entry.status,
          stability: source.entry.stability,
        }),
      ],
    );
  }
}
