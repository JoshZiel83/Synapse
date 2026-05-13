import {
  type CanonicalContentBlock,
  type CanonicalFileCategory,
  type ToolParameterProperty,
} from "@synapse/shared"
import { getFileRecord, toCanonicalFileRefBlock } from "../files/service.js"
import {
  fileToBase64,
  fileToBuffer,
  type FileRecord,
} from "../../infrastructure/storage/file-io.js"

const FILE_REF_TAG_REGEX = /<FileRef\s+id="([^"]+)"\s*\/>/i
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SUPPORTED_VISION_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
])

function mimeToCategory(mimeType: string): CanonicalFileCategory {
  if (mimeType.startsWith("image/")) return "image"
  if (mimeType.startsWith("audio/")) return "audio"
  if (mimeType.startsWith("video/")) return "video"
  return "document"
}

export function fileRefProperty(description: string): ToolParameterProperty {
  return {
    type: "string",
    description: `${description} Pass the exact FileRef string, for example <FileRef id="..."/>.`,
  }
}

export function fileRefsProperty(description: string): ToolParameterProperty {
  return {
    type: "array",
    description: `${description} Each item must be an exact FileRef string, for example <FileRef id="..."/>.`,
    items: { type: "string" },
  }
}

export function pluginOutputFileRef(
  record: FileRecord
): Extract<CanonicalContentBlock, { type: "file_ref" }> {
  return toCanonicalFileRefBlock(record)
}

export function extractFileRefId(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim()
    const match = trimmed.match(FILE_REF_TAG_REGEX)
    if (match) return match[1]
    if (UUID_REGEX.test(trimmed)) return trimmed
    return null
  }

  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>
    if (typeof candidate.fileId === "string") return candidate.fileId
    if (typeof candidate.id === "string") return candidate.id
  }

  return null
}

export async function resolveFileRefRecord(
  value: unknown,
  label: string,
  expectedCategory?: CanonicalFileCategory
): Promise<FileRecord> {
  const fileId = extractFileRefId(value)
  if (!fileId) {
    throw new Error(
      `${label} must be a FileRef string like <FileRef id="..."/>`
    )
  }

  const record = await getFileRecord(fileId)
  if (!record) {
    throw new Error(`File not found for ${label}: ${fileId}`)
  }

  if (expectedCategory) {
    const actualCategory = mimeToCategory(record.mimeType)
    if (actualCategory !== expectedCategory) {
      throw new Error(
        `${label} must reference a ${expectedCategory} file, got ${actualCategory}`
      )
    }
  }

  return record
}

async function ensureSupportedVisionImage(
  buffer: Buffer,
  mimeType: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (SUPPORTED_VISION_IMAGE_MIME_TYPES.has(mimeType)) {
    return { buffer, mimeType }
  }

  const sharp = (await import("sharp")).default
  const converted = await sharp(buffer).png().toBuffer()
  return { buffer: converted, mimeType: "image/png" }
}

export async function resolveImageFileRefToDataUrl(
  value: unknown,
  label = "fileRef"
): Promise<string> {
  const record = await resolveFileRefRecord(value, label, "image")
  const originalBuffer = await fileToBuffer(record)
  const { buffer, mimeType } = await ensureSupportedVisionImage(
    originalBuffer,
    record.mimeType
  )
  return `data:${mimeType};base64,${buffer.toString("base64")}`
}

export async function resolveAudioFileRefToBase64(
  value: unknown,
  label = "fileRef"
): Promise<{ base64: string; mimeType: string }> {
  const record = await resolveFileRefRecord(value, label, "audio")
  const base64 = await fileToBase64(record)
  return { base64, mimeType: record.mimeType }
}

export async function resolveVideoFileRefToPublicUrl(
  value: unknown,
  label = "fileRef"
): Promise<string> {
  const record = await resolveFileRefRecord(value, label, "video")
  return record.fullUrl
}
