import { parseJsonObjectOrUndefined } from "@synapse/shared"

export type PdfParseMetadataInput = {
  info?: unknown
  metadata?: unknown
  numpages?: unknown
}

export function normalizePdfParseMetadata(
  parsed: PdfParseMetadataInput
): Record<string, unknown> {
  return {
    info: parseJsonObjectOrUndefined(parsed.info),
    metadata: parseJsonObjectOrUndefined(parsed.metadata),
    numPages: typeof parsed.numpages === "number" ? parsed.numpages : undefined,
  }
}
