/**
 * Strategy interface for provider-specific content block formatting.
 *
 * Each AI provider has its own format for multimodal content blocks (images,
 * audio, documents). Implementations translate a common PreparedMedia into
 * the provider's native block format.
 */

export interface PreparedMedia {
  base64: string;
  mimeType: string;
  sizeBytes: number;
  absoluteUrl: string;
}

export interface ContentAdapterStrategy {
  /** Build an image content block, or null if unsupported */
  buildImageBlock(media: PreparedMedia): unknown | null;
  /** Build an audio content block, or null if unsupported */
  buildAudioBlock(media: PreparedMedia): unknown | null;
  /** Build a document content block, or null if unsupported */
  buildDocumentBlock(media: PreparedMedia): unknown | null;
}
