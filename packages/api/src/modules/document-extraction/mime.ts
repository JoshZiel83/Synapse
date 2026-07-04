// The document-extraction layer's responsibility boundary: the binary document
// formats it routes to a provider. Deliberately EXCLUDES:
//   - images (contentKind==="image") → modules/ocr owns them (one modality, one module)
//   - text-like MIME types (text/*, json, xml, svg, xhtml) → the parse pipeline
//     decodes them as utf8 BEFORE consulting this layer, so text/html stays a raw
//     utf8 read (unchanged) rather than a Tika extraction.
// This set is the UNION of formats any document provider might handle; each
// provider's supports() narrows it to what THAT engine actually does. Routing uses
// this to decide "this is a document → ask the provider" vs "unsupported mime".

/** PDF — the format the pre-refactor pipeline handled (now via a provider). */
const PDF = "application/pdf"

/** Office (OOXML + legacy MS + OpenDocument) + EPUB — NET-NEW capability: these
 *  were `unsupported_mime` SKIPs before this layer. Apache Tika parses them all. */
const OFFICE_AND_EBOOK = [
  // OOXML
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // xlsx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // pptx
  // legacy MS Office
  "application/msword", // doc
  "application/vnd.ms-excel", // xls
  "application/vnd.ms-powerpoint", // ppt
  // OpenDocument
  "application/vnd.oasis.opendocument.text", // odt
  "application/vnd.oasis.opendocument.spreadsheet", // ods
  "application/vnd.oasis.opendocument.presentation", // odp
  // e-book
  "application/epub+zip", // epub
  // rich text (application/* form; text/rtf is caught earlier as text-like)
  "application/rtf", // rtf
] as const

/** Every MIME type the document-extraction layer is responsible for. */
export const DOCUMENT_MIME_TYPES: ReadonlySet<string> = new Set([
  PDF,
  ...OFFICE_AND_EBOOK,
])

/** True when a MIME type is a document this layer should route to a provider. */
export function isDocumentMimeType(mimeType: string): boolean {
  return DOCUMENT_MIME_TYPES.has(mimeType)
}
