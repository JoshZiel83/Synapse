import type { MultimodalConfig, ProviderType } from '@synapse/shared';
import { readAsBuffer } from '../../infrastructure/storage/index.js';
import { getContentAdapter } from './content-adapters/index.js';
import type { PreparedMedia } from './content-adapters/types.js';

export interface Attachment {
  id: string;
  url: string;
  fullUrl?: string;
  storedName?: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}

// Formats supported by both Anthropic and OpenAI
const SUPPORTED_IMAGE_FORMATS = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
]);

function getAttachmentCategory(mimeType: string): 'image' | 'audio' | 'video' | 'document' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'document';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Convert unsupported image formats (avif, bmp, tiff, svg, etc.) to PNG using sharp.
 * Returns { buffer, mimeType } — either converted or original.
 */
async function ensureSupportedFormat(
  buffer: Buffer,
  mimeType: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (SUPPORTED_IMAGE_FORMATS.has(mimeType)) {
    return { buffer, mimeType };
  }
  try {
    const sharp = (await import('sharp')).default;
    const converted = await sharp(buffer).png().toBuffer();
    return { buffer: converted, mimeType: 'image/png' };
  } catch (err) {
    console.error(`[content-adapter] Failed to convert ${mimeType} to PNG:`, err);
    return { buffer, mimeType };
  }
}

/**
 * Read an attachment from disk and prepare media metadata for provider adapters.
 */
async function prepareMedia(att: Attachment): Promise<PreparedMedia | null> {
  try {
    let buffer: Buffer;
    if (att.storedName) {
      buffer = await readAsBuffer(att.storedName);
    } else {
      const storedName = att.url.replace(/^\/files\//, '');
      buffer = await readAsBuffer(storedName);
    }

    const category = getAttachmentCategory(att.mimeType);

    // Convert unsupported image formats to PNG
    if (category === 'image') {
      const result = await ensureSupportedFormat(buffer, att.mimeType);
      buffer = result.buffer;
      return {
        base64: buffer.toString('base64'),
        mimeType: result.mimeType,
        sizeBytes: buffer.length,
        absoluteUrl: att.fullUrl || att.url,
      };
    }

    return {
      base64: buffer.toString('base64'),
      mimeType: att.mimeType,
      sizeBytes: buffer.length,
      absoluteUrl: att.fullUrl || att.url,
    };
  } catch (err) {
    console.error(`[content-adapter] Failed to read file ${att.originalName}:`, err);
    return null;
  }
}

/**
 * Adapt attachments for AI provider consumption.
 * Delegates provider-specific block formatting to ContentAdapterStrategy.
 */
export async function adaptAttachments(
  textContent: string,
  attachments: Attachment[],
  multimodal?: MultimodalConfig | null,
  providerType?: ProviderType,
): Promise<{ contentBlocks: unknown[]; textFallback: string }> {
  if (!attachments || attachments.length === 0) {
    return { contentBlocks: [{ type: 'text', text: textContent }], textFallback: textContent };
  }

  const adapter = getContentAdapter(providerType);
  const supportedTypes = multimodal?.supported ? new Set(multimodal.types) : new Set<string>();
  const blocks: unknown[] = [];
  const fallbackParts: string[] = [textContent];

  for (const att of attachments) {
    const category = getAttachmentCategory(att.mimeType);
    const isSupported = supportedTypes.has(category);

    if (!isSupported) {
      fallbackParts.push(
        `[Attached file: ${att.originalName} (${att.mimeType}, ${formatBytes(att.sizeBytes)}) - ${att.url}]`
      );
      continue;
    }

    const media = await prepareMedia(att);
    if (!media) {
      // File read failed — URL-only fallback via adapter
      const absoluteUrl = att.fullUrl || att.url;
      const urlMedia: PreparedMedia = { base64: '', mimeType: att.mimeType, sizeBytes: 0, absoluteUrl };
      let block: unknown | null = null;
      switch (category) {
        case 'image': block = adapter.buildImageBlock(urlMedia); break;
        case 'audio': block = adapter.buildAudioBlock(urlMedia); break;
        case 'document': block = adapter.buildDocumentBlock(urlMedia); break;
      }
      if (block) {
        blocks.push(block);
      } else {
        fallbackParts.push(
          `[Attached file: ${att.originalName} (${att.mimeType}, ${formatBytes(att.sizeBytes)}) - ${att.url}]`
        );
      }
      continue;
    }

    let block: unknown | null = null;
    switch (category) {
      case 'image': block = adapter.buildImageBlock(media); break;
      case 'audio': block = adapter.buildAudioBlock(media); break;
      case 'document': block = adapter.buildDocumentBlock(media); break;
    }

    if (block) {
      blocks.push(block);
    } else {
      fallbackParts.push(
        `[Attached file: ${att.originalName} (${att.mimeType}, ${formatBytes(att.sizeBytes)}) - ${att.url}]`
      );
    }
  }

  const finalBlocks: unknown[] = [
    { type: 'text', text: fallbackParts.join('\n') },
    ...blocks,
  ];

  return {
    contentBlocks: finalBlocks,
    textFallback: fallbackParts.join('\n'),
  };
}
