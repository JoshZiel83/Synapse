import { db } from "../../infrastructure/database/kysely.js"
import {
  requireInstantDate,
  serializeInstant,
} from "../../infrastructure/datetime.js"
import {
  fileRefBlock,
  parseJsonObject,
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
  toFileOriginSummary,
  type FileOriginInput,
  type StoredFileRecord,
} from "./model.js"

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

type FileJoinRow = {
  id: string
  workspaceId: string | null
  uploaderUserId: string | null
  originalName: string
  mimeType: string
  contentKind: FileRecordView["contentKind"]
  sizeBytes: string | number
  contentSha256: string
  createdAt: Date | null
  sourceFamily: FileRecordView["originSummary"]["family"]
  sourceSystem: FileRecordView["originSummary"]["system"]
  initiatorActorId: string | null
  parentAssetId: string | null
  detailsJson: unknown
}

function mapStoredFileRecord(row: FileJoinRow): StoredFileRecord {
  const origin = {
    family: row.sourceFamily,
    system: row.sourceSystem,
    initiatorActorId: row.initiatorActorId,
    parentFileId: row.parentAssetId,
    details: parseJsonObject(row.detailsJson),
  } satisfies FileOriginInput

  return {
    id: row.id,
    assetId: row.id,
    workspaceId: row.workspaceId,
    uploaderUserId: row.uploaderUserId,
    originalName: row.originalName,
    url: getStableFileUrl(row.id),
    fullUrl: getStableFullFileUrl(row.id),
    mimeType: row.mimeType,
    contentKind: row.contentKind,
    sizeBytes: Number(row.sizeBytes),
    sha256: row.contentSha256,
    storageBackend: "local_cas",
    originSummary: toFileOriginSummary(origin),
    createdAt: serializeInstant(
      requireInstantDate(row.createdAt, `file_assets.${row.id}.created_at`)
    ),
  }
}

async function getJoinedFileRow(
  fileId: string,
  workspaceId?: string
): Promise<FileJoinRow | null> {
  // file_assets folds in the old file_origins columns, so no join needed.
  let query = db
    .selectFrom("fileAssets as f")
    .select([
      "f.id",
      "f.workspaceId",
      "f.uploaderUserId",
      "f.originalName",
      "f.mimeType",
      "f.contentKind",
      "f.sizeBytes",
      "f.contentSha256",
      "f.createdAt",
      "f.sourceFamily",
      "f.sourceSystem",
      "f.initiatorActorId",
      "f.parentAssetId",
      "f.detailsJson",
    ])
    .where("f.id", "=", fileId)

  if (workspaceId) {
    query = query.where("f.workspaceId", "=", workspaceId)
  }

  return (await query.executeTakeFirst()) as FileJoinRow | null
}

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
  const row = await getJoinedFileRow(fileId)
  return row ? mapStoredFileRecord(row) : null
}

export async function getFileDetail(
  fileId: string
): Promise<FileRecordView | null> {
  const row = await getJoinedFileRow(fileId)
  return row ? mapStoredFileRecord(row) : null
}

export async function getFileAccessInfo(
  fileId: string
): Promise<FileAccessInfo | null> {
  const row = await getJoinedFileRow(fileId)
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
  const row = await getJoinedFileRow(fileId, workspaceId)
  return row ? mapStoredFileRecord(row) : null
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
 * Best-effort MIME for a content blob. content_blobs deliberately stores no MIME
 * (the same sha can be presented as different MIME in different contexts), so we
 * read it back from whatever references the sha: an entity asset, or any file_ref
 * part that carries a mime_type. Falls back to application/octet-stream.
 */
export async function getContentMimeBySha(sha256: string): Promise<string> {
  const asset = await db
    .selectFrom("fileAssets")
    .select("mimeType")
    .where("contentSha256", "=", sha256)
    .limit(1)
    .executeTakeFirst()
  if (asset?.mimeType) return asset.mimeType

  const part = await db
    .selectFrom("conversationItemParts")
    .select("mimeType")
    .where("refSha256", "=", sha256)
    .where("mimeType", "is not", null)
    .limit(1)
    .executeTakeFirst()
  if (part?.mimeType) return part.mimeType

  const toolPart = await db
    .selectFrom("toolResultParts")
    .select("mimeType")
    .where("refSha256", "=", sha256)
    .where("mimeType", "is not", null)
    .limit(1)
    .executeTakeFirst()
  if (toolPart?.mimeType) return toolPart.mimeType

  return "application/octet-stream"
}

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

export async function canUserAccessFileWorkspace(
  workspaceId: string | null,
  userId: string
): Promise<boolean> {
  if (!workspaceId) return true

  const row = await db
    .selectFrom("workspaces as w")
    .leftJoin("workspaceMembers as wm", (join) =>
      join.onRef("wm.workspaceId", "=", "w.id").on("wm.userId", "=", userId)
    )
    .select("w.id")
    .where("w.id", "=", workspaceId)
    .where((eb) =>
      eb.or([eb("w.ownerId", "=", userId), eb("wm.userId", "is not", null)])
    )
    .limit(1)
    .executeTakeFirst()

  return Boolean(row)
}
