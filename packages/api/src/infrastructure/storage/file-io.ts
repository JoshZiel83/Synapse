import { db } from "../database/kysely.js"
import type { FileStorageBackend } from "@synapse/shared/types"
import {
  downloadToBuffer,
  getStableFileUrl,
  getStableFullFileUrl,
  normalizeOriginalNameForMimeType,
  readStoredBlobAsBase64,
  readStoredBlobAsBuffer,
  resolveBufferMimeType,
  storeBufferInBackend,
} from "./index.js"
import {
  mimeToFileContentKind,
  toFileOriginSummary,
  type FileOriginInput,
  type StoredFileRecord,
} from "../../modules/files/model.js"
import { createLogger } from "../logger/index.js"

const log = createLogger("file-io")

export type FileRecord = StoredFileRecord

type CreateStoredFileParams = {
  buffer: Buffer
  originalName: string
  mimeType: string
  workspaceId: string | null
  uploaderUserId: string | null
  origin: FileOriginInput
  backend?: FileStorageBackend
}

function toJsonObject(value: Record<string, unknown>): any {
  return value as any
}

function assertExplicitOrigin(
  origin: FileOriginInput | undefined
): asserts origin is FileOriginInput {
  if (!origin?.family || !origin.system) {
    throw new Error(
      "File origin is required and must include family plus system."
    )
  }
}

function normalizeDetails(
  value: Record<string, unknown> | undefined
): Record<string, unknown> {
  return value && Object.keys(value).length > 0 ? value : {}
}

async function createStoredFile(
  params: CreateStoredFileParams
): Promise<FileRecord> {
  assertExplicitOrigin(params.origin)

  const resolvedMimeType = await resolveBufferMimeType(
    params.buffer,
    params.mimeType
  )
  const normalizedOriginalName = normalizeOriginalNameForMimeType(
    params.originalName,
    resolvedMimeType
  )
  const storedBlob = await storeBufferInBackend({
    backend: params.backend || "local_fs",
    buffer: params.buffer,
    originalName: normalizedOriginalName,
    mimeType: resolvedMimeType,
  })
  const contentKind = mimeToFileContentKind(resolvedMimeType)

  const record = await db.transaction().execute(async (trx) => {
    const blob = await trx
      .insertInto("file_blobs")
      .values({
        backend: storedBlob.backend,
        storage_key: storedBlob.storageKey,
        bucket: storedBlob.bucket,
        locator_json: toJsonObject(storedBlob.locator),
      })
      .returning([
        "id",
        "backend",
        "storage_key",
        "bucket",
        "locator_json",
        "created_at",
      ])
      .executeTakeFirstOrThrow()

    const file = await trx
      .insertInto("files")
      .values({
        workspace_id: params.workspaceId,
        uploader_user_id: params.uploaderUserId,
        original_name: normalizedOriginalName,
        mime_type: resolvedMimeType,
        content_kind: contentKind,
        size_bytes: String(storedBlob.sizeBytes),
        sha256: storedBlob.sha256,
        blob_id: blob.id,
      })
      .returning([
        "id",
        "workspace_id",
        "uploader_user_id",
        "original_name",
        "mime_type",
        "content_kind",
        "size_bytes",
        "sha256",
        "created_at",
      ])
      .executeTakeFirstOrThrow()

    await trx
      .insertInto("file_origins")
      .values({
        file_id: file.id,
        source_family: params.origin.family,
        source_system: params.origin.system,
        initiator_user_id: params.origin.initiatorUserId ?? null,
        initiator_actor_id: params.origin.initiatorActorId ?? null,
        provider_key: params.origin.providerKey ?? null,
        plugin_id: params.origin.pluginId ?? null,
        parent_file_id: params.origin.parentFileId ?? null,
        external_resource_key: params.origin.externalResourceKey ?? null,
        details_json: toJsonObject(normalizeDetails(params.origin.details)),
      })
      .execute()

    return {
      id: file.id,
      workspaceId: file.workspace_id,
      uploaderUserId: file.uploader_user_id,
      originalName: file.original_name,
      url: getStableFileUrl(file.id),
      fullUrl: getStableFullFileUrl(file.id),
      mimeType: file.mime_type,
      contentKind: file.content_kind,
      sizeBytes: Number(file.size_bytes),
      sha256: file.sha256,
      storageBackend: blob.backend,
      originSummary: toFileOriginSummary(params.origin),
      createdAt:
        file.created_at instanceof Date
          ? file.created_at.toISOString()
          : String(file.created_at),
      blobId: blob.id,
      storageKey: blob.storage_key,
      bucket: blob.bucket,
      locator:
        blob.locator_json && typeof blob.locator_json === "object"
          ? (blob.locator_json as Record<string, unknown>)
          : {},
    }
  })

  void import("../../modules/files/parse-service.js")
    .then(({ enqueueDefaultFileParse }) =>
      enqueueDefaultFileParse({
        fileId: record.id,
        mimeType: record.mimeType,
        contentKind: record.contentKind,
      })
    )
    .catch((error) => {
      log.error(
        { err: error },
        `[file-io] Failed to enqueue default file parse for ${record.id}`
      )
    })

  return record
}

export async function fileToBase64(
  record: Pick<
    FileRecord,
    "storageBackend" | "storageKey" | "bucket" | "locator"
  >
): Promise<string> {
  return readStoredBlobAsBase64({
    backend: record.storageBackend,
    storageKey: record.storageKey,
    bucket: record.bucket,
    locator: record.locator,
  })
}

export async function fileToBuffer(
  record: Pick<
    FileRecord,
    "storageBackend" | "storageKey" | "bucket" | "locator"
  >
): Promise<Buffer> {
  return readStoredBlobAsBuffer({
    backend: record.storageBackend,
    storageKey: record.storageKey,
    bucket: record.bucket,
    locator: record.locator,
  })
}

export async function saveFromUrl(
  url: string,
  workspaceId: string | null,
  uploaderUserId: string | null,
  originalName: string | undefined,
  origin: FileOriginInput,
  backend: FileStorageBackend = "local_fs"
): Promise<FileRecord> {
  const downloaded = await downloadToBuffer(url, originalName)
  return createStoredFile({
    buffer: downloaded.buffer,
    originalName: downloaded.originalName,
    mimeType: downloaded.mimeType,
    workspaceId,
    uploaderUserId,
    origin,
    backend,
  })
}

export async function saveFromBase64(
  base64: string,
  originalName: string,
  mimeType: string,
  workspaceId: string | null,
  uploaderUserId: string | null,
  origin: FileOriginInput,
  backend: FileStorageBackend = "local_fs"
): Promise<FileRecord> {
  return createStoredFile({
    buffer: Buffer.from(base64, "base64"),
    originalName,
    mimeType,
    workspaceId,
    uploaderUserId,
    origin,
    backend,
  })
}

export async function saveFromBuffer(
  buffer: Buffer,
  originalName: string,
  mimeType: string,
  workspaceId: string | null,
  uploaderUserId: string | null,
  origin: FileOriginInput,
  backend: FileStorageBackend = "local_fs"
): Promise<FileRecord> {
  return createStoredFile({
    buffer,
    originalName,
    mimeType,
    workspaceId,
    uploaderUserId,
    origin,
    backend,
  })
}
