/**
 * Anthropic Messages API content adapter.
 *
 * Image block format (base64):
 *   { type: 'image', source: { type: 'base64', media_type, data } }
 * Image block format (URL):
 *   { type: 'image', source: { type: 'url', url } }
 * Supported image types: image/jpeg, image/png, image/gif, image/webp
 * Max image size: 5 MB per image (API), 8000x8000 px single, 2000x2000 px if >20 images
 * @see https://platform.claude.com/docs/en/build-with-claude/vision
 *
 * Document block format (base64):
 *   { type: 'document', source: { type: 'base64', media_type, data } }
 * Document block format (URL):
 *   { type: 'document', source: { type: 'url', url } }
 * Max request size: 32 MB, max 100 pages per PDF
 * @see https://platform.claude.com/docs/en/build-with-claude/pdf-support
 *
 * Audio input: NOT supported in Messages API.
 */
import type { ContentAdapterStrategy, PreparedMedia } from './types.js';

// Anthropic API enforces 5 MB per base64 image.
// @see https://platform.claude.com/docs/en/build-with-claude/vision#is-there-a-limit-to-the-image-file-size-i-can-upload
const BASE64_THRESHOLD = 5 * 1024 * 1024;

export const anthropicAdapter: ContentAdapterStrategy = {
  buildImageBlock({ base64, mimeType, sizeBytes, absoluteUrl }: PreparedMedia) {
    // Small images → base64 inline; large images → URL reference (avoids extra HTTP round-trip).
    if (sizeBytes <= BASE64_THRESHOLD) {
      return { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } };
    }
    return { type: 'image', source: { type: 'url', url: absoluteUrl } };
  },

  buildAudioBlock() {
    // Anthropic Messages API does not accept audio input content blocks.
    return null;
  },

  buildDocumentBlock({ base64, mimeType, sizeBytes, absoluteUrl }: PreparedMedia) {
    // Same base64/URL split as images. URL source does NOT take media_type per the official docs.
    if (sizeBytes <= BASE64_THRESHOLD) {
      return { type: 'document', source: { type: 'base64', media_type: mimeType, data: base64 } };
    }
    return { type: 'document', source: { type: 'url', url: absoluteUrl } };
  },
};
