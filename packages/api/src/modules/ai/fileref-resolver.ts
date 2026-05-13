/**
 * FileRef Resolver: validate and resolve <FileRef id="..."/> segments
 * from model output text into CanonicalContentBlock[].
 */
import { textBlock, type CanonicalContentBlock } from "@synapse/shared"
import { getFileRecord, toCanonicalFileRefBlock } from "../files/service.js"

export type FileRefSegment =
  | { type: "text"; text: string }
  | { type: "ref"; fileId: string }

export function parseFileRefSegments(text: string): FileRefSegment[] {
  const regex = /<FileRef\s+id="([^"]+)"\s*\/>/g
  const segments: FileRefSegment[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", text: text.slice(lastIndex, match.index) })
    }
    segments.push({ type: "ref", fileId: match[1] })
    lastIndex = regex.lastIndex
  }

  if (lastIndex < text.length) {
    segments.push({ type: "text", text: text.slice(lastIndex) })
  }

  return segments
}

/**
 * Resolve FileRef segments (from provider.parseFileRefs) into CanonicalContentBlock[].
 * Text segments pass through; ref segments are looked up in the DB.
 */
export async function resolveFileRefSegments(
  segments: FileRefSegment[]
): Promise<CanonicalContentBlock[]> {
  const blocks: CanonicalContentBlock[] = []

  for (const seg of segments) {
    if (seg.type === "text") {
      if (seg.text) blocks.push(textBlock(seg.text))
      continue
    }

    // Look up file record in DB
    const file = await getFileRecord(seg.fileId)
    if (file) {
      blocks.push(toCanonicalFileRefBlock(file))
    } else {
      blocks.push(textBlock(`[File not found: ${seg.fileId}]`))
    }
  }

  return blocks
}
