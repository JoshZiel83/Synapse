/**
 * OpenAI Chat Completions API content adapter.
 *
 * Image block format (base64 data-URI):
 *   { type: 'image_url', image_url: { url: 'data:<mime>;base64,<data>' } }
 * Image block format (URL):
 *   { type: 'image_url', image_url: { url } }
 * Supported image types: image/jpeg, image/png, image/gif, image/webp (non-animated)
 * Max image size: 20 MB per image, 50 MB total payload
 * @see https://developers.openai.com/api/docs/guides/images-vision
 *
 * Audio input block format:
 *   { type: 'input_audio', input_audio: { data: '<base64>', format: 'wav' | 'mp3' } }
 * Supported input audio formats: wav, mp3
 * @see https://developers.openai.com/api/docs/guides/audio
 *
 * Document blocks: NOT supported in Chat Completions API.
 * (OpenAI Responses API has `input_file`, but Chat Completions does not.)
 * @see https://developers.openai.com/api/docs/guides/file-inputs
 */
import type { ContentAdapterStrategy, PreparedMedia } from './types.js';

// OpenAI enforces 20 MB per image.
// @see https://developers.openai.com/api/docs/guides/images-vision
const BASE64_THRESHOLD = 20 * 1024 * 1024;

export const openaiAdapter: ContentAdapterStrategy = {
  buildImageBlock({ base64, mimeType, sizeBytes, absoluteUrl }: PreparedMedia) {
    // Small images → base64 data-URI; large images → URL reference.
    if (sizeBytes <= BASE64_THRESHOLD) {
      return { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } };
    }
    return { type: 'image_url', image_url: { url: absoluteUrl } };
  },

  buildAudioBlock({ base64, mimeType }: PreparedMedia) {
    // OpenAI input_audio supports 'wav' and 'mp3' formats only.
    const format = mimeType.includes('wav') ? 'wav'
      : mimeType.includes('mp3') || mimeType.includes('mpeg') ? 'mp3'
      : 'wav'; // default to wav for other audio types
    return { type: 'input_audio', input_audio: { data: base64, format } };
  },

  buildDocumentBlock() {
    // OpenAI Chat Completions API does not support document/PDF content blocks.
    // The Responses API has `input_file` but that uses a different endpoint.
    return null;
  },
};
