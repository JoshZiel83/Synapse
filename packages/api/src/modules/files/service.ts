import {
  fileRefBlock,
  type CanonicalFileRefBlock,
  type FileRecordView,
} from "@synapse/shared"
import {
  fileToBase64,
  fileToBuffer,
  saveFromBuffer,
  type FileRecord,
} from "../../infrastructure/storage/file-io.js"
import {
  getStableFileUrl,
  getStableFullFileUrl,
  readCasBlob,
  CONTENT_URL_PREFIX,
  BASE_URL,
} from "../../infrastructure/storage/index.js"
import {
  buildActorOutputOrigin,
  buildExternalImportOrigin,
  buildModelOutputOrigin,
  buildPackageImportOrigin,
  buildPlatformAssetOrigin,
  resolveModelResponseMediaOriginSystem,
  buildSystemGeneratedOrigin,
  buildToolOutputOrigin,
  buildUserUploadOrigin,
  mimeToFileContentKind,
  mimeToCanonicalFileCategory,
  type FileOriginInput,
  type StoredFileRecord,
} from "./model.js"
import { presentFileAsset } from "./presenter.js"
import {
  canUserAccessFileWorkspace,
  getContentMimeBySha,
  getFileAssetJoinRow,
} from "./repo.js"

// repo.ts owns the DB reads (guard r8); re-export the two that external
// importers (controller.ts, skills/service.ts, auth/service.ts) pull from here
// so their import paths stay unchanged.
export { canUserAccessFileWorkspace, getContentMimeBySha }

export type { FileOriginInput, StoredFileRecord }
export {
  buildActorOutputOrigin,
  buildExternalImportOrigin,
  buildModelOutputOrigin,
  buildPackageImportOrigin,
  buildPlatformAssetOrigin,
  resolveModelResponseMediaOriginSystem,
  buildSystemGeneratedOrigin,
  buildToolOutputOrigin,
  buildUserUploadOrigin,
  mimeToFileContentKind,
  mimeToCanonicalFileCategory,
}

export type FileAccessInfo = Pick<
  FileRecordView,
  "id" | "workspaceId" | "mimeType" | "originalName" | "contentKind"
>

export function getFileUrlById(fileId: string): string {
  return getStableFileUrl(fileId)
}

export function getFullFileUrlById(fileId: string): string {
  return getStableFullFileUrl(fileId)
}

export async function storeFile(params: {
  buffer: Buffer
  originalName: string
  mimeType: string
  workspaceId: string | null
  uploaderUserId?: string | null
  origin: FileOriginInput
}): Promise<FileRecord> {
  return saveFromBuffer(
    params.buffer,
    params.originalName,
    params.mimeType,
    params.workspaceId,
    params.uploaderUserId ?? null,
    params.origin
  )
}

export async function uploadFile(
  buffer: Buffer,
  originalName: string,
  mimeType: string,
  workspaceId: string,
  uploaderUserId: string,
  origin: FileOriginInput
): Promise<FileRecord> {
  return storeFile({
    buffer,
    originalName,
    mimeType,
    workspaceId,
    uploaderUserId,
    origin,
  })
}

export async function getFileRecord(
  fileId: string
): Promise<StoredFileRecord | null> {
  const row = await getFileAssetJoinRow(fileId)
  return row ? presentFileAsset(row) : null
}

export async function getFileDetail(
  fileId: string
): Promise<FileRecordView | null> {
  const row = await getFileAssetJoinRow(fileId)
  return row ? presentFileAsset(row) : null
}

export async function getFileAccessInfo(
  fileId: string
): Promise<FileAccessInfo | null> {
  const row = await getFileAssetJoinRow(fileId)
  if (!row) {
    return null
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    mimeType: row.mimeType,
    originalName: row.originalName,
    contentKind: row.contentKind,
  }
}

export async function getWorkspaceFileDetail(
  fileId: string,
  workspaceId: string
): Promise<FileRecordView | null> {
  const row = await getFileAssetJoinRow(fileId, workspaceId)
  return row ? presentFileAsset(row) : null
}

export async function duplicateFileRecord(
  fileId: string,
  options: {
    workspaceId: string | null
    uploaderUserId: string | null
    origin: FileOriginInput
  }
): Promise<FileRecord | null> {
  const existing = await getFileRecord(fileId)
  if (!existing) {
    return null
  }

  const buffer = await fileToBuffer(existing)
  return storeFile({
    buffer,
    originalName: existing.originalName,
    mimeType: existing.mimeType,
    workspaceId: options.workspaceId,
    uploaderUserId: options.uploaderUserId,
    origin: options.origin,
  })
}

export async function readFileBufferById(
  fileId: string
): Promise<Buffer | null> {
  const record = await getFileRecord(fileId)
  if (!record) return null
  return fileToBuffer(record)
}

export async function readFileBase64ById(
  fileId: string
): Promise<string | null> {
  const record = await getFileRecord(fileId)
  if (!record) return null
  return fileToBase64(record)
}

// Content-addressed read/url helpers. The file-service refactor addresses
// blobs by sha256; providers read bytes + build native-media URLs by sha.
export async function readContentBufferBySha(
  sha256: string
): Promise<Buffer | null> {
  try {
    return await readCasBlob(sha256)
  } catch {
    return null
  }
}

/**
 * Best-effort MIME for a content blob lives in repo.ts (guard r8) and is
 * re-exported from this module's top for unchanged importers.
 */

/** Relative content URL for a sha256: /content/<sha256>. */
export function getContentUrlBySha(sha256: string): string {
  return `${CONTENT_URL_PREFIX}${sha256}`
}

/** Absolute content URL for a sha256. */
export function getFullContentUrlBySha(sha256: string): string {
  return `${BASE_URL}${getContentUrlBySha(sha256)}`
}

export function toCanonicalFileRefBlock(
  record: Pick<
    FileRecordView,
    "mimeType" | "originalName" | "sizeBytes" | "sha256"
  >
): CanonicalFileRefBlock {
  return fileRefBlock({
    sha256: record.sha256,
    mimeType: record.mimeType,
    name: record.originalName,
    sizeBytes: record.sizeBytes,
    category: mimeToCanonicalFileCategory(record.mimeType),
  })
}
