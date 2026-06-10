import { db } from "../database/kysely.js"
import { serializeInstant } from "../datetime.js"
import type { FileStorageBackend } from "@synapse/shared/types"
import { createLogger } from "../logger/index.js"
import {
  downloadToBuffer,
  getStableFileUrl,
  getStableFullFileUrl,
  normalizeOriginalNameForMimeType,
  putBufferCas,
  readCasBlob,
  readCasBlobBase64,
  resolveBufferMimeType,
} from "./index.js"
import {
  mimeToFileContentKind,
  toFileOriginSummary,
  type FileOriginInput,
  type StoredFileRecord,
} from "../../modules/files/model.js"

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
  // Content-address the bytes (sha256 dedup). Same sha = one physical blob.
  const blobRef = await putBufferCas(params.buffer)
  const contentKind = mimeToFileContentKind(resolvedMimeType)

  const record = await db.transaction().execute(async (trx) => {
    // Upsert the content_blobs row (sha256 PK). ON CONFLICT DO NOTHING: a
    // dedup hit means the row already exists with identical content.
    await trx
      .insertInto("contentBlobs")
      .values({
        sha256: blobRef.sha256,
        sizeBytes: String(blobRef.sizeBytes),
        backend: "local_cas",
        locatorJson: toJsonObject({}),
      })
      .onConflict((oc) => oc.column("sha256").doNothing())
      .execute()

    const asset = await trx
      .insertInto("fileAssets")
      .values({
        workspaceId: params.workspaceId,
        contentSha256: blobRef.sha256,
        originalName: normalizedOriginalName,
        mimeType: resolvedMimeType,
        contentKind: contentKind,
        sizeBytes: String(blobRef.sizeBytes),
        uploaderUserId: params.uploaderUserId,
        initiatorActorId: params.origin.initiatorActorId ?? null,
        sourceFamily: params.origin.family,
        sourceSystem: params.origin.system,
        parentAssetId: params.origin.parentFileId ?? null,
        detailsJson: toJsonObject(normalizeDetails(params.origin.details)),
      })
      .returning([
        "id",
        "workspaceId",
        "uploaderUserId",
        "originalName",
        "mimeType",
        "contentKind",
        "sizeBytes",
        "contentSha256",
        "createdAt",
      ])
      .executeTakeFirstOrThrow()

    return {
      id: asset.id,
      assetId: asset.id,
      workspaceId: asset.workspaceId,
      uploaderUserId: asset.uploaderUserId,
      originalName: asset.originalName,
      url: getStableFileUrl(asset.id),
      fullUrl: getStableFullFileUrl(asset.id),
      mimeType: asset.mimeType,
      contentKind: asset.contentKind,
      sizeBytes: Number(asset.sizeBytes),
      sha256: asset.contentSha256,
      storageBackend: "local_cas" as FileStorageBackend,
      originSummary: toFileOriginSummary(params.origin),
      createdAt: serializeInstant(asset.createdAt),
    } satisfies StoredFileRecord
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
  record: Pick<FileRecord, "sha256">
): Promise<string> {
  return readCasBlobBase64(record.sha256)
}

export async function fileToBuffer(
  record: Pick<FileRecord, "sha256">
): Promise<Buffer> {
  return readCasBlob(record.sha256)
}

export async function saveFromUrl(
  url: string,
  workspaceId: string | null,
  uploaderUserId: string | null,
  originalName: string | undefined,
  origin: FileOriginInput,
  backend: FileStorageBackend = "local_cas"
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
  backend: FileStorageBackend = "local_cas"
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
  backend: FileStorageBackend = "local_cas"
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
