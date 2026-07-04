// Document text normalization. UNLIKE the OCR layer (which collapses all
// whitespace to single spaces and caps at 4000 chars — right for a short image
// caption), documents preserve their line structure and are NOT length-capped:
// this is byte-for-byte the pre-refactor pdf-parse normalization
// (parse-service.ts `normalizeExtractedText`: strip NUL bytes -> trim), so the
// stored text is unchanged in shape. Postgres text columns reject U+0000, hence
// the NUL strip.

const NUL_BYTES = new RegExp(String.fromCharCode(0), "g")

export function normalizeDocumentText(text: string): string {
  return text.replace(NUL_BYTES, "").trim()
}
