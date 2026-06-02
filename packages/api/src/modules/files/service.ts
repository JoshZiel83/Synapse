import { db } from "../../infrastructure/database/kysely.js"
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

function toIsoString(value: string | Date | null | undefined): string {
  if (typeof value === "string") return value
  if (value instanceof Date) return value.toISOString()
  return new Date(0).toISOString()
}

type FileJoinRow = {
  id: string
  workspace_id: string | null
  uploader_user_id: string | null
  original_name: string
  mime_type: string
  content_kind: FileRecordView["contentKind"]
  size_bytes: string | number
  content_sha256: string
  created_at: string | Date | null
  source_family: FileRecordView["originSummary"]["family"]
  source_system: FileRecordView["originSummary"]["system"]
  initiator_actor_id: string | null
  parent_asset_id: string | null
  details_json: unknown
}

function mapStoredFileRecord(row: FileJoinRow): StoredFileRecord {
  const origin = {
    family: row.source_family,
    system: row.source_system,
    initiatorActorId: row.initiator_actor_id,
    parentFileId: row.parent_asset_id,
    details: parseJsonObject(row.details_json),
  } satisfies FileOriginInput

  return {
    id: row.id,
    assetId: row.id,
    workspaceId: row.workspace_id,
    uploaderUserId: row.uploader_user_id,
    originalName: row.original_name,
    url: getStableFileUrl(row.id),
    fullUrl: getStableFullFileUrl(row.id),
    mimeType: row.mime_type,
    contentKind: row.content_kind,
    sizeBytes: Number(row.size_bytes),
    sha256: row.content_sha256,
    storageBackend: "local_cas",
    originSummary: toFileOriginSummary(origin),
    createdAt: toIsoString(row.created_at),
  }
}

async function getJoinedFileRow(
  fileId: string,
  workspaceId?: string
): Promise<FileJoinRow | null> {
  // file_assets folds in the old file_origins columns, so no join needed.
  let query = db
    .selectFrom("file_assets as f")
    .select([
      "f.id",
      "f.workspace_id",
      "f.uploader_user_id",
      "f.original_name",
      "f.mime_type",
      "f.content_kind",
      "f.size_bytes",
      "f.content_sha256",
      "f.created_at",
      "f.source_family",
      "f.source_system",
      "f.initiator_actor_id",
      "f.parent_asset_id",
      "f.details_json",
    ])
    .where("f.id", "=", fileId)

  if (workspaceId) {
    query = query.where("f.workspace_id", "=", workspaceId)
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
    workspaceId: row.workspace_id,
    mimeType: row.mime_type,
    originalName: row.original_name,
    contentKind: row.content_kind,
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
    .selectFrom("file_assets")
    .select("mime_type")
    .where("content_sha256", "=", sha256)
    .limit(1)
    .executeTakeFirst()
  if (asset?.mime_type) return asset.mime_type

  const part = await db
    .selectFrom("conversation_item_parts")
    .select("mime_type")
    .where("ref_sha256", "=", sha256)
    .where("mime_type", "is not", null)
    .limit(1)
    .executeTakeFirst()
  if (part?.mime_type) return part.mime_type

  const toolPart = await db
    .selectFrom("tool_result_parts")
    .select("mime_type")
    .where("ref_sha256", "=", sha256)
    .where("mime_type", "is not", null)
    .limit(1)
    .executeTakeFirst()
  if (toolPart?.mime_type) return toolPart.mime_type

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
    .leftJoin("workspace_members as wm", (join) =>
      join.onRef("wm.workspace_id", "=", "w.id").on("wm.user_id", "=", userId)
    )
    .select("w.id")
    .where("w.id", "=", workspaceId)
    .where((eb) =>
      eb.or([eb("w.owner_id", "=", userId), eb("wm.user_id", "is not", null)])
    )
    .limit(1)
    .executeTakeFirst()

  return Boolean(row)
}
