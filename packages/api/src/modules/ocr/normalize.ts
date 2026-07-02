// Shared OCR text normalization. Kept identical to the pre-refactor
// image-fallback behaviour (trim → collapse whitespace → cap length) so the
// migrated tesseract path produces byte-for-byte the same text.

const MAX_OCR_TEXT_LENGTH = 4000

export function normalizeOcrText(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, MAX_OCR_TEXT_LENGTH)
}
