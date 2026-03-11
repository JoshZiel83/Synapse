import type { CanonicalContentBlock } from '@synapse/shared';
import { parseFileRefSegments, resolveFileRefSegments } from '../ai/fileref-resolver.js';

export type DraftConversationPart = {
  type: 'text' | 'file_ref' | 'json';
  text?: string;
  fileId?: string;
  json?: unknown;
  mimeType?: string;
  name?: string;
  metadata?: Record<string, unknown>;
};

function isCanonicalContentBlock(value: unknown): value is CanonicalContentBlock {
  if (!value || typeof value !== 'object') return false;

  const block = value as Record<string, unknown>;
  if (block.type === 'text') {
    return typeof block.text === 'string';
  }

  if (block.type === 'file_ref') {
    return typeof block.fileId === 'string' && typeof block.mimeType === 'string';
  }

  return false;
}

function getCategoryFromMimeType(mimeType: string): 'image' | 'audio' | 'video' | 'document' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'document';
}

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return (value || {}) as Record<string, unknown>;
}

function blocksToDraftParts(blocks: CanonicalContentBlock[]): DraftConversationPart[] {
  const parts: DraftConversationPart[] = [];

  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text) {
        parts.push({ type: 'text', text: block.text });
      }
      continue;
    }

    parts.push({
      type: 'file_ref',
      fileId: block.fileId,
      mimeType: block.mimeType,
      name: block.originalName,
      metadata: {
        id: block.fileId,
        originalName: block.originalName,
        storedName: block.storedName,
        mimeType: block.mimeType,
        sizeBytes: block.sizeBytes,
        url: block.url,
        category: block.category,
      },
    });
  }

  return parts;
}

export function draftPartsToCanonicalContentBlocks(parts: DraftConversationPart[]): CanonicalContentBlock[] {
  const blocks: CanonicalContentBlock[] = [];

  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text) {
        blocks.push({ type: 'text', text: part.text });
      }
      continue;
    }

    if (part.type === 'file_ref' && part.fileId) {
      const metadata = part.metadata || {};
      const mimeType = typeof metadata.mimeType === 'string'
        ? metadata.mimeType
        : part.mimeType || 'application/octet-stream';
      blocks.push({
        type: 'file_ref',
        fileId: part.fileId,
        storedName: typeof metadata.storedName === 'string' ? metadata.storedName : '',
        url: typeof metadata.url === 'string' ? metadata.url : `/api/v1/files/${part.fileId}`,
        mimeType,
        originalName: typeof metadata.originalName === 'string'
          ? metadata.originalName
          : part.name || 'file',
        sizeBytes: typeof metadata.sizeBytes === 'number' ? metadata.sizeBytes : 0,
        category: (metadata.category as 'image' | 'audio' | 'video' | 'document' | undefined) || getCategoryFromMimeType(mimeType),
      });
    }
  }

  return blocks;
}

export function itemPartsToCanonicalContentBlocks(parts: any[]): CanonicalContentBlock[] {
  const blocks: CanonicalContentBlock[] = [];

  for (const part of parts || []) {
    if (part.part_type === 'text') {
      if (part.text_value) {
        blocks.push({ type: 'text', text: part.text_value });
      }
      continue;
    }

    if (part.part_type === 'file_ref' && part.file_id) {
      const metadata = parseJson(part.metadata);
      const mimeType = part.file_mime_type || part.mime_type || 'application/octet-stream';
      blocks.push({
        type: 'file_ref',
        fileId: part.file_id,
        storedName: part.stored_name || String(metadata.storedName || ''),
        url: typeof metadata.url === 'string' ? metadata.url : `/api/v1/files/${part.file_id}`,
        mimeType,
        originalName: part.original_name || part.name || 'file',
        sizeBytes: part.size_bytes || Number(metadata.sizeBytes || 0),
        category: (metadata.category as 'image' | 'audio' | 'video' | 'document' | undefined) || getCategoryFromMimeType(mimeType),
      });
    }
  }

  return blocks;
}

function buildTextContentFromDraftParts(parts: DraftConversationPart[]) {
  return parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text || '')
    .join('\n');
}

async function buildBlocksFromContent(content: string): Promise<CanonicalContentBlock[]> {
  if (!content) return [];

  const segments = parseFileRefSegments(content);
  if (segments.some((segment) => segment.type === 'ref')) {
    return resolveFileRefSegments(segments);
  }

  return [{ type: 'text', text: content }];
}

export async function buildNormalizedMessageContent(params: {
  content: string;
  contentBlocks?: CanonicalContentBlock[];
  metadata?: Record<string, unknown>;
}): Promise<{
  parts: DraftConversationPart[];
  contentBlocks: CanonicalContentBlock[];
  normalizedContent: string;
  normalizedMetadata: Record<string, unknown>;
}> {
  const { content, contentBlocks, metadata = {} } = params;
  const { attachments: _attachments, parsedContent: _parsedContent, ...normalizedMetadata } = metadata as Record<string, unknown> & {
    attachments?: unknown;
    parsedContent?: unknown;
  };

  const explicitBlocks = Array.isArray(contentBlocks)
    ? contentBlocks.filter(isCanonicalContentBlock)
    : [];
  const baseBlocks = explicitBlocks.length > 0
    ? explicitBlocks
    : await buildBlocksFromContent(content);

  const parts = blocksToDraftParts(baseBlocks);

  if (parts.length === 0) {
    parts.push({ type: 'text', text: '' });
  }

  return {
    parts,
    contentBlocks: draftPartsToCanonicalContentBlocks(parts),
    normalizedContent: buildTextContentFromDraftParts(parts),
    normalizedMetadata,
  };
}
