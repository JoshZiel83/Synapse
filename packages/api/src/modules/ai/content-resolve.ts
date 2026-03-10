/**
 * Content Resolve: convert CanonicalContentBlock[] into provider-native format,
 * with capability filtering and format conversion.
 */
import type { CanonicalContentBlock, MultimodalConfig, ProviderType } from '@synapse/shared';
import { readAsBuffer } from '../../infrastructure/storage/index.js';
import { getFullUrl } from '../../infrastructure/storage/index.js';
import { getContentAdapter } from './content-adapters/index.js';
import type { PreparedMedia } from './content-adapters/types.js';

const SUPPORTED_IMAGE_FORMATS = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
]);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Convert unsupported image formats to PNG using sharp.
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
    console.error(`[content-resolve] Failed to convert ${mimeType} to PNG:`, err);
    return { buffer, mimeType };
  }
}

/**
 * Resolve CanonicalContentBlock[] to provider-native content blocks.
 * - text blocks → provider text block
 * - file_ref blocks → check multimodal capability → read from disk → build provider block or text fallback
 */
export async function resolveContentBlocks(
  blocks: CanonicalContentBlock[],
  providerType: ProviderType,
  multimodal?: MultimodalConfig,
): Promise<{ providerBlocks: unknown[]; textFallback: string }> {
  const adapter = getContentAdapter(providerType);
  const supportedTypes = multimodal?.supported ? new Set(multimodal.types) : new Set<string>();
  const providerBlocks: unknown[] = [];
  const textParts: string[] = [];

  for (const block of blocks) {
    if (block.type === 'text') {
      providerBlocks.push({ type: 'text', text: block.text });
      textParts.push(block.text);
      continue;
    }

    // file_ref block — check capability
    if (!supportedTypes.has(block.category)) {
      // Unsupported — text fallback
      const desc = `[${block.category}: ${block.originalName} (${block.mimeType}, ${formatBytes(block.sizeBytes)})]`;
      providerBlocks.push({ type: 'text', text: desc });
      textParts.push(desc);
      continue;
    }

    // Supported — read from disk and build provider-native block
    try {
      let buffer = await readAsBuffer(block.storedName);
      let mimeType = block.mimeType;

      // For images, ensure supported format
      if (block.category === 'image') {
        const result = await ensureSupportedFormat(buffer, mimeType);
        buffer = result.buffer;
        mimeType = result.mimeType;
      }

      const media: PreparedMedia = {
        base64: buffer.toString('base64'),
        mimeType,
        sizeBytes: buffer.length,
        absoluteUrl: getFullUrl(block.storedName),
      };

      let providerBlock: unknown | null = null;
      switch (block.category) {
        case 'image': providerBlock = adapter.buildImageBlock(media); break;
        case 'audio': providerBlock = adapter.buildAudioBlock(media); break;
        case 'document': providerBlock = adapter.buildDocumentBlock(media); break;
        case 'video': providerBlock = null; break; // No provider supports video input yet
      }

      if (providerBlock) {
        providerBlocks.push(providerBlock);
        // Text fallback for video/unsupported
        textParts.push(`[${block.category}: ${block.originalName}]`);
      } else {
        const desc = `[${block.category}: ${block.originalName} (${block.mimeType}, ${formatBytes(block.sizeBytes)}) - provider does not support this type]`;
        providerBlocks.push({ type: 'text', text: desc });
        textParts.push(desc);
      }
    } catch (err: any) {
      console.error(`[content-resolve] Failed to resolve file_ref ${block.storedName}:`, err.message);
      const desc = `[${block.category}: ${block.originalName} (read failed)]`;
      providerBlocks.push({ type: 'text', text: desc });
      textParts.push(desc);
    }
  }

  return { providerBlocks, textFallback: textParts.join('\n') };
}
