import crypto from 'node:crypto';

export type MemoryEmbeddingInputType = 'query' | 'passage';

export function normalizeMemoryEmbeddingText(text: string, inputType: MemoryEmbeddingInputType) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return `${inputType}: ${normalized}`;
}

export function hashMemoryEmbeddingText(text: string, inputType: MemoryEmbeddingInputType) {
  return crypto
    .createHash('sha256')
    .update(normalizeMemoryEmbeddingText(text, inputType))
    .digest('hex');
}
