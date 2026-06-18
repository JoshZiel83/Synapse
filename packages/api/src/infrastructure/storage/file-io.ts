import { serializeInstant } from "../datetime.js"
import type { FileStorageBackend } from "@synapse/shared/types"
import { createLogger } from "../logger/index.js"
import {
  downloadToBuffer,
  getStableFileUrl,
  getStableFullFileUrl,
  normalizeOriginalNameForMimeType,
  resolveBufferMimeType,
} from "./index.js"
import {
  writeContentBlob,
  readContentBuffer,
  readContentBase64,
} from "./content-store.js"
import {
  mimeToFileContentKind,
  toFileOriginSummary,
  type FileOriginInput,
  type StoredFileRecord,
} from "../../modules/files/model.js"
import { persistLocalCasFileAsset } from "./repo.js"

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
  const contentKind = mimeToFileContentKind(resolvedMimeType)
  // Content-address the bytes (sha256 dedup). Same sha = one physical blob.
  // The routing context decides the backend; the chosen backend (blobRef.backend)
  // is what we persist — the vestigial `params.backend` is no longer threaded in.
  const blobRef = await writeContentBlob(params.buffer, {
    workspaceId: params.workspaceId,
    originFamily: params.origin.family,
    originSystem: params.origin.system,
    contentKind,
    sizeBytes: params.buffer.length,
  })

  const asset = await persistLocalCasFileAsset({
    workspaceId: params.workspaceId,
    contentSha256: blobRef.sha256,
    originalName: normalizedOriginalName,
    mimeType: resolvedMimeType,
    contentKind: contentKind,
    sizeBytes: blobRef.sizeBytes,
    uploaderUserId: params.uploaderUserId,
    initiatorActorId: params.origin.initiatorActorId ?? null,
    sourceFamily: params.origin.family,
    sourceSystem: params.origin.system,
    parentAssetId: params.origin.parentFileId ?? null,
    details: normalizeDetails(params.origin.details),
    backend: blobRef.backend,
  })

  const record = {
    id: asset.id,
    assetId: asset.id,
    workspaceId: asset.workspaceId,
    uploaderUserId: asset.uploaderUserId,
    originalName: asset.originalName,
    url: getStableFileUrl(asset.id),
    fullUrl: getStableFullFileUrl(asset.id),
    mimeType: asset.mimeType,
    contentKind: asset.contentKind,
    sizeBytes: asset.sizeBytes,
    sha256: asset.contentSha256,
    storageBackend: asset.storageBackend,
    originSummary: toFileOriginSummary(params.origin),
    createdAt: serializeInstant(asset.createdAt),
  } satisfies StoredFileRecord

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
  return readContentBase64(record.sha256)
}

export async function fileToBuffer(
  record: Pick<FileRecord, "sha256">
): Promise<Buffer> {
  return readContentBuffer(record.sha256)
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
