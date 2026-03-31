import { fileRefBlock, normalizeCanonicalContentBlocks, textBlock, textBlocks, type CanonicalContentBlock, type CanonicalFileCategory } from '@synapse/shared';
import type { NormalizedMcpToolResult } from '@synapse/shared/types';
import { saveFromBase64, saveFromUrl, type FileRecord } from '../../infrastructure/storage/file-io.js';

export interface McpResultNormalizeOptions {
  binaryMetadata?: Record<string, unknown>;
}

function mimeToCategory(mimeType: string): CanonicalFileCategory {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'document';
}

function fileRecordToFileRef(rec: FileRecord, category: CanonicalFileCategory): CanonicalContentBlock {
  return fileRefBlock({
    fileId: rec.id,
    storedName: rec.storedName,
    url: rec.url,
    mimeType: rec.mimeType,
    originalName: rec.originalName,
    sizeBytes: rec.sizeBytes,
    category,
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function mergeBinaryMetadata(
  base?: Record<string, unknown>,
  specific?: Record<string, unknown>,
): Record<string, unknown> {
  if (!base && !specific) {
    return {};
  }
  return {
    ...(base || {}),
    ...(specific || {}),
  };
}

async function normalizeMcpContentArray(
  content: unknown[],
  workspaceId: string,
  options?: McpResultNormalizeOptions,
): Promise<CanonicalContentBlock[]> {
  const blocks: CanonicalContentBlock[] = [];

  for (const raw of content) {
    const block = raw as any;
    if (!block || typeof block !== 'object') {
      blocks.push(textBlock(String(raw)));
      continue;
    }

    switch (block.type) {
      case 'text':
        blocks.push(textBlock(block.text || ''));
        break;

      case 'file_ref':
        blocks.push(...normalizeCanonicalContentBlocks([block]));
        break;

      case 'image': {
        try {
          if (block.source?.data) {
            const mimeType = block.source.media_type || 'image/png';
            const rec = await saveFromBase64(
              block.source.data,
              `mcp-image.${mimeType.split('/')[1] || 'png'}`,
              mimeType,
              workspaceId,
              null,
              'plugin_output',
              options?.binaryMetadata,
            );
            blocks.push(fileRecordToFileRef(rec, 'image'));
            break;
          }
          if (block.source?.type === 'url' && block.source?.url) {
            const rec = await saveFromUrl(
              block.source.url,
              workspaceId,
              null,
              'mcp-image.png',
              'plugin_output',
              options?.binaryMetadata,
            );
            blocks.push(fileRecordToFileRef(rec, mimeToCategory(rec.mimeType)));
            break;
          }
          if (block.data) {
            const mimeType = block.mimeType || block.mime_type || 'image/png';
            const rec = await saveFromBase64(
              block.data,
              `mcp-image.${mimeType.split('/')[1] || 'png'}`,
              mimeType,
              workspaceId,
              null,
              'plugin_output',
              options?.binaryMetadata,
            );
            blocks.push(fileRecordToFileRef(rec, 'image'));
            break;
          }
          blocks.push(textBlock(`[Image: missing data, keys=${Object.keys(block).join(',')}]`));
        } catch (err: any) {
          console.error('[mcp-result-normalizer] Failed to ingest image:', err.message);
          blocks.push(textBlock(`[Image: ingest failed - ${err.message}]`));
        }
        break;
      }

      case 'audio': {
        try {
          if (block.data) {
            const mimeType = block.mimeType || block.mime_type || 'audio/wav';
            const rec = await saveFromBase64(
              block.data,
              `mcp-audio.${mimeType.split('/')[1] || 'wav'}`,
              mimeType,
              workspaceId,
              null,
              'plugin_output',
              options?.binaryMetadata,
            );
            blocks.push(fileRecordToFileRef(rec, 'audio'));
            break;
          }
          blocks.push(textBlock('[Audio: missing data]'));
        } catch (err: any) {
          console.error('[mcp-result-normalizer] Failed to ingest audio:', err.message);
          blocks.push(textBlock(`[Audio: ingest failed - ${err.message}]`));
        }
        break;
      }

      case 'resource': {
        try {
          if (block.resource?.text) {
            blocks.push(textBlock(block.resource.text));
          } else if (block.resource?.blob && block.resource?.mimeType) {
            const mimeType = block.resource.mimeType;
            const category = mimeToCategory(mimeType);
            const ext = mimeType.split('/')[1] || 'bin';
            const originalName =
              typeof block.resource?.name === 'string' && block.resource.name.trim()
                ? block.resource.name.trim()
                : `mcp-resource.${ext}`;
            const perFileMetadata = mergeBinaryMetadata(
              options?.binaryMetadata,
              asRecord(block.resource?.metadata),
            );
            const rec = await saveFromBase64(
              block.resource.blob,
              originalName,
              mimeType,
              workspaceId,
              null,
              'plugin_output',
              perFileMetadata,
            );
            blocks.push(fileRecordToFileRef(rec, category));
          } else if (block.resource?.uri) {
            blocks.push(textBlock(String(block.resource.uri)));
          } else {
            blocks.push(textBlock(JSON.stringify(block)));
          }
        } catch (err: any) {
          console.error('[mcp-result-normalizer] Failed to ingest resource:', err.message);
          blocks.push(textBlock(JSON.stringify(block)));
        }
        break;
      }

      default:
        if (typeof block.text === 'string' && block.text) {
          blocks.push(textBlock(block.text));
        } else {
          blocks.push(textBlock(JSON.stringify(block)));
        }
        break;
    }
  }

  return blocks;
}

export async function normalizeMcpToolResult(
  rawResult: unknown,
  workspaceId: string,
  options?: McpResultNormalizeOptions,
): Promise<NormalizedMcpToolResult> {
  if (typeof rawResult === 'string') {
    return {
      content: textBlocks(rawResult),
      rawResult,
    };
  }

  if (Array.isArray(rawResult)) {
    return {
      content: await normalizeMcpContentArray(rawResult, workspaceId, options),
      rawResult,
    };
  }

  if (!rawResult || typeof rawResult !== 'object') {
    return {
      content: textBlocks(String(rawResult)),
      rawResult,
    };
  }

  const candidate = rawResult as Record<string, unknown>;
  const structuredContent = candidate.structuredContent && typeof candidate.structuredContent === 'object'
    ? candidate.structuredContent as Record<string, unknown>
    : undefined;

  if (typeof candidate.content === 'string') {
    return {
      content: textBlocks(candidate.content),
      isError: candidate.isError === true,
      structuredContent,
      rawResult,
    };
  }

  if (Array.isArray(candidate.content)) {
    return {
      content: await normalizeMcpContentArray(candidate.content, workspaceId, options),
      isError: candidate.isError === true,
      structuredContent,
      rawResult,
    };
  }

  if (structuredContent) {
    return {
      content: textBlocks(JSON.stringify(structuredContent)),
      isError: candidate.isError === true,
      structuredContent,
      rawResult,
    };
  }

  return {
    content: textBlocks(JSON.stringify(rawResult)),
    isError: candidate.isError === true,
    rawResult,
  };
}
