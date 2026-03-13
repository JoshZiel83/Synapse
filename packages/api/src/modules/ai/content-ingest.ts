/**
 * Content Ingest: normalize arbitrary binary content (MCP results, model responses)
 * into platform file storage and return CanonicalContentBlock[].
 */
import { fileRefBlock, normalizeCanonicalContentBlocks, textBlock, type CanonicalContentBlock, type ProviderType } from '@synapse/shared';
import { saveFromBase64, saveFromUrl, type FileRecord } from '../../infrastructure/storage/file-io.js';

function mimeToCategory(mimeType: string): 'image' | 'audio' | 'video' | 'document' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'document';
}

function fileRecordToFileRef(rec: FileRecord, category: 'image' | 'audio' | 'video' | 'document'): CanonicalContentBlock {
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

/**
 * Normalize MCP tool result content into CanonicalContentBlock[].
 * - string → wrapped as [{ type: 'text', text }]
 * - unknown[] (MCP content blocks) → binary stored to files table, returns CanonicalContentBlock[]
 */
export async function ingestToolResultContent(
  content: string | unknown[],
  workspaceId: string,
): Promise<CanonicalContentBlock[]> {
  if (typeof content === 'string') return [textBlock(content)];

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
        // Already-ingested canonical block — pass through directly
        blocks.push(...normalizeCanonicalContentBlocks([block]));
        break;

      case 'image': {
        try {
          // Case 1: Anthropic-native format { source: { type: "base64", media_type, data } }
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
          // Case 2: Anthropic URL format { source: { type: "url", url } }
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
          // Case 3: MCP standard format { data, mimeType }
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
          blocks.push(textBlock(`[Image: missing data, keys=${Object.keys(block).join(',')}]`));
        } catch (err: any) {
          console.error('[content-ingest] Failed to ingest image:', err.message);
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
            );
            blocks.push(fileRecordToFileRef(rec, 'audio'));
            break;
          }
          blocks.push(textBlock('[Audio: missing data]'));
        } catch (err: any) {
          console.error('[content-ingest] Failed to ingest audio:', err.message);
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
            const rec = await saveFromBase64(
              block.resource.blob,
              `mcp-resource.${ext}`,
              mimeType,
              workspaceId,
              null,
              'plugin_output',
            );
            blocks.push(fileRecordToFileRef(rec, category));
          } else {
            blocks.push(textBlock(JSON.stringify(block)));
          }
        } catch (err: any) {
          console.error('[content-ingest] Failed to ingest resource:', err.message);
          blocks.push(textBlock(JSON.stringify(block)));
        }
        break;
      }

      default:
        // Pass through as text
        blocks.push(textBlock(JSON.stringify(block)));
        break;
    }
  }

  return blocks;
}

/**
 * Ingest media content blocks from model API response into platform file storage.
 * Returns CanonicalContentBlock[] (file_ref blocks) for embedding into ToolRound.content.
 */
export async function ingestResponseMedia(
  rawBlocks: unknown[],
  providerType: ProviderType,
  workspaceId: string,
): Promise<CanonicalContentBlock[]> {
  const blocks: CanonicalContentBlock[] = [];

  if (providerType === 'anthropic') {
    for (const block of rawBlocks as any[]) {
      if (block.type !== 'image') continue;
      try {
        if (block.source?.data) {
          const mimeType = block.source.media_type || 'image/png';
          const rec = await saveFromBase64(
            block.source.data,
            `model-image.${mimeType.split('/')[1] || 'png'}`,
            mimeType,
            workspaceId,
            null,
            'ai_output',
          );
          blocks.push(fileRecordToFileRef(rec, 'image'));
        } else if (block.source?.type === 'url' && block.source?.url) {
          const rec = await saveFromUrl(
            block.source.url,
            workspaceId,
            null,
            'model-image.png',
            'ai_output',
          );
          blocks.push(fileRecordToFileRef(rec, mimeToCategory(rec.mimeType)));
        }
      } catch (err: any) {
        console.error('[content-ingest] Failed to ingest response media:', err.message);
      }
    }
  }

  // OpenAI: future-proof — when their API returns media blocks, handle similarly

  return blocks;
}
