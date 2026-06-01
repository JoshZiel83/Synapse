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
  sha256: string
  created_at: string | Date | null
  blob_id: string
  backend: FileRecordView["storageBackend"]
  storage_key: string
  bucket: string | null
  locator_json: unknown
  source_family: FileRecordView["originSummary"]["family"]
  source_system: FileRecordView["originSummary"]["system"]
  initiator_user_id: string | null
  initiator_actor_id: string | null
  provider_key: string | null
  parent_file_id: string | null
  external_resource_key: string | null
  details_json: unknown
}

function mapStoredFileRecord(row: FileJoinRow): StoredFileRecord {
  const origin = {
    family: row.source_family,
    system: row.source_system,
    initiatorUserId: row.initiator_user_id,
    initiatorActorId: row.initiator_actor_id,
    providerKey: row.provider_key ?? undefined,
    parentFileId: row.parent_file_id,
    externalResourceKey: row.external_resource_key ?? undefined,
    details: parseJsonObject(row.details_json),
  } satisfies FileOriginInput

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    uploaderUserId: row.uploader_user_id,
    originalName: row.original_name,
    url: getStableFileUrl(row.id),
    fullUrl: getStableFullFileUrl(row.id),
    mimeType: row.mime_type,
    contentKind: row.content_kind,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    storageBackend: row.backend,
    originSummary: toFileOriginSummary(origin),
    createdAt: toIsoString(row.created_at),
    blobId: row.blob_id,
    storageKey: row.storage_key,
    bucket: row.bucket,
    locator: parseJsonObject(row.locator_json),
  }
}

async function getJoinedFileRow(
  fileId: string,
  workspaceId?: string
): Promise<FileJoinRow | null> {
  let query = db
    .selectFrom("files as f")
    .innerJoin("file_blobs as fb", "fb.id", "f.blob_id")
    .innerJoin("file_origins as fo", "fo.file_id", "f.id")
    .select([
      "f.id",
      "f.workspace_id",
      "f.uploader_user_id",
      "f.original_name",
      "f.mime_type",
      "f.content_kind",
      "f.size_bytes",
      "f.sha256",
      "f.created_at",
      "f.blob_id",
      "fb.backend",
      "fb.storage_key",
      "fb.bucket",
      "fb.locator_json",
      "fo.source_family",
      "fo.source_system",
      "fo.initiator_user_id",
      "fo.initiator_actor_id",
      "fo.provider_key",
      "fo.parent_file_id",
      "fo.external_resource_key",
      "fo.details_json",
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

export function toCanonicalFileRefBlock(
  record: Pick<
    FileRecordView,
    "id" | "url" | "mimeType" | "originalName" | "sizeBytes"
  >
): CanonicalFileRefBlock {
  return fileRefBlock({
    fileId: record.id,
    url: record.url,
    mimeType: record.mimeType,
    originalName: record.originalName,
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
