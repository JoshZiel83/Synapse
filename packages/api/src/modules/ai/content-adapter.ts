import type { CanonicalContentBlock, MultimodalConfig, ProviderType } from '@synapse/shared';
import { resolveContentBlocks } from './content-resolve.js';

export interface Attachment {
  id: string;
  url: string;
  fullUrl?: string;
  storedName?: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}

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
 * Convert Attachment[] to CanonicalContentBlock[] (file_ref format).
 */
export function attachmentsToCanonicalBlocks(attachments: Attachment[]): CanonicalContentBlock[] {
  return attachments.map((att): CanonicalContentBlock => ({
    type: 'file_ref',
    fileId: att.id,
    storedName: att.storedName || att.url.replace(/^\/files\//, ''),
    url: att.url,
    mimeType: att.mimeType,
    originalName: att.originalName,
    sizeBytes: att.sizeBytes,
    category: getAttachmentCategory(att.mimeType),
  }));
}

/**
 * Adapt attachments for AI provider consumption.
 * Converts to CanonicalContentBlock[] then resolves via unified resolveContentBlocks.
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

  // Convert Attachment[] → CanonicalContentBlock[]
  const canonicalBlocks = attachmentsToCanonicalBlocks(attachments);

  // Resolve via unified content resolver
  const { providerBlocks, textFallback: mediaFallback } = await resolveContentBlocks(
    canonicalBlocks,
    providerType || 'anthropic',
    multimodal || undefined,
  );

  // Build final blocks: text first, then media
  const finalBlocks: unknown[] = [
    { type: 'text', text: textContent + (mediaFallback ? '\n' + mediaFallback : '') },
    ...providerBlocks.filter((b: any) => b.type !== 'text'), // exclude text blocks (already in textFallback)
  ];

  return {
    contentBlocks: finalBlocks,
    textFallback: textContent + (mediaFallback ? '\n' + mediaFallback : ''),
  };
}
