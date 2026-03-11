import type { CanonicalContentBlock } from '@synapse/shared';
import type { NormalizedMcpToolResult } from '@synapse/shared/types';
import { saveFromBase64, saveFromUrl, type FileRecord } from '../../infrastructure/storage/file-io.js';

function mimeToCategory(mimeType: string): 'image' | 'audio' | 'video' | 'document' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'document';
}

function fileRecordToFileRef(rec: FileRecord, category: 'image' | 'audio' | 'video' | 'document'): CanonicalContentBlock {
  return {
    type: 'file_ref',
    fileId: rec.id,
    storedName: rec.storedName,
    url: rec.url,
    mimeType: rec.mimeType,
    originalName: rec.originalName,
    sizeBytes: rec.sizeBytes,
    category,
  };
}

function textBlock(text: string): CanonicalContentBlock[] {
  return [{ type: 'text', text }];
}

async function normalizeMcpContentArray(
  content: unknown[],
  workspaceId: string,
): Promise<CanonicalContentBlock[]> {
  const blocks: CanonicalContentBlock[] = [];

  for (const raw of content) {
    const block = raw as any;
    if (!block || typeof block !== 'object') {
      blocks.push({ type: 'text', text: String(raw) });
      continue;
    }

    switch (block.type) {
      case 'text':
        blocks.push({ type: 'text', text: block.text || '' });
        break;

      case 'file_ref':
        blocks.push(block as CanonicalContentBlock);
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
            );
            blocks.push(fileRecordToFileRef(rec, 'image'));
            break;
          }
          blocks.push({ type: 'text', text: `[Image: missing data, keys=${Object.keys(block).join(',')}]` });
        } catch (err: any) {
          console.error('[mcp-result-normalizer] Failed to ingest image:', err.message);
          blocks.push({ type: 'text', text: `[Image: ingest failed - ${err.message}]` });
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
            );
            blocks.push(fileRecordToFileRef(rec, 'audio'));
            break;
          }
          blocks.push({ type: 'text', text: '[Audio: missing data]' });
        } catch (err: any) {
          console.error('[mcp-result-normalizer] Failed to ingest audio:', err.message);
          blocks.push({ type: 'text', text: `[Audio: ingest failed - ${err.message}]` });
        }
        break;
      }

      case 'resource': {
        try {
          if (block.resource?.text) {
            blocks.push({ type: 'text', text: block.resource.text });
          } else if (block.resource?.blob && block.resource?.mimeType) {
            const mimeType = block.resource.mimeType;
            const category = mimeToCategory(mimeType);
            const ext = mimeType.split('/')[1] || 'bin';
            const rec = await saveFromBase64(
              block.resource.blob,
              `mcp-resource.${ext}`,
              mimeType,
              workspaceId,
              null,
              'plugin_output',
            );
            blocks.push(fileRecordToFileRef(rec, category));
          } else if (block.resource?.uri) {
            blocks.push({ type: 'text', text: String(block.resource.uri) });
          } else {
            blocks.push({ type: 'text', text: JSON.stringify(block) });
          }
        } catch (err: any) {
          console.error('[mcp-result-normalizer] Failed to ingest resource:', err.message);
          blocks.push({ type: 'text', text: JSON.stringify(block) });
        }
        break;
      }

      default:
        if (typeof block.text === 'string' && block.text) {
          blocks.push({ type: 'text', text: block.text });
        } else {
          blocks.push({ type: 'text', text: JSON.stringify(block) });
        }
        break;
    }
  }

  return blocks;
}

export async function normalizeMcpToolResult(
  rawResult: unknown,
  workspaceId: string,
): Promise<NormalizedMcpToolResult> {
  if (typeof rawResult === 'string') {
    return {
      content: textBlock(rawResult),
      rawResult,
    };
  }

  if (Array.isArray(rawResult)) {
    return {
      content: await normalizeMcpContentArray(rawResult, workspaceId),
      rawResult,
    };
  }

  if (!rawResult || typeof rawResult !== 'object') {
    return {
      content: textBlock(String(rawResult)),
      rawResult,
    };
  }

  const candidate = rawResult as Record<string, unknown>;
  const structuredContent = candidate.structuredContent && typeof candidate.structuredContent === 'object'
    ? candidate.structuredContent as Record<string, unknown>
    : undefined;

  if (typeof candidate.content === 'string') {
    return {
      content: textBlock(candidate.content),
      isError: candidate.isError === true,
      structuredContent,
      rawResult,
    };
  }

  if (Array.isArray(candidate.content)) {
    return {
      content: await normalizeMcpContentArray(candidate.content, workspaceId),
      isError: candidate.isError === true,
      structuredContent,
      rawResult,
    };
  }

  if (structuredContent) {
    return {
      content: textBlock(JSON.stringify(structuredContent)),
      isError: candidate.isError === true,
      structuredContent,
      rawResult,
    };
  }

  return {
    content: textBlock(JSON.stringify(rawResult)),
    isError: candidate.isError === true,
    rawResult,
  };
}
