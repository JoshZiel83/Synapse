import type { FileStorageBackend } from "@synapse/shared/types"
import { db, type Executor, type TableInsert } from "../database/kysely.js"

type ContentBlobLocatorJson = TableInsert<"contentBlobs">["locatorJson"]
type FileAssetDetailsJson = TableInsert<"fileAssets">["detailsJson"]
type FileAssetInsert = TableInsert<"fileAssets">

export interface StoredFileAssetInsert {
  workspaceId: string | null
  contentSha256: string
  originalName: string
  mimeType: string
  contentKind: FileAssetInsert["contentKind"]
  sizeBytes: number
  uploaderUserId: string | null
  initiatorActorId: string | null
  sourceFamily: FileAssetInsert["sourceFamily"]
  sourceSystem: string
  parentAssetId: string | null
  details: Record<string, unknown>
}

export interface PersistLocalCasFileInput extends StoredFileAssetInsert {
  backend: FileStorageBackend
}

export interface PersistedStoredFileAsset {
  id: string
  workspaceId: string | null
  uploaderUserId: string | null
  originalName: string
  mimeType: string
  contentKind: FileAssetInsert["contentKind"]
  sizeBytes: number
  contentSha256: string
  createdAt: Date
  storageBackend: FileStorageBackend
}

function toContentBlobLocatorJson(
  value: Record<string, unknown>
): ContentBlobLocatorJson {
  return value as ContentBlobLocatorJson
}

function toFileAssetDetailsJson(
  value: Record<string, unknown>
): FileAssetDetailsJson {
  return value as FileAssetDetailsJson
}

async function upsertContentBlob(
  executor: Executor,
  params: {
    sha256: string
    sizeBytes: number
    backend: FileStorageBackend
  }
) {
  await executor
    .insertInto("contentBlobs")
    .values({
      sha256: params.sha256,
      sizeBytes: String(params.sizeBytes),
      backend: params.backend,
      locatorJson: toContentBlobLocatorJson({}),
    })
    .onConflict((oc) => oc.column("sha256").doNothing())
    .execute()
}

async function insertFileAsset(
  executor: Executor,
  params: StoredFileAssetInsert
) {
  return executor
    .insertInto("fileAssets")
    .values({
      workspaceId: params.workspaceId,
      contentSha256: params.contentSha256,
      originalName: params.originalName,
      mimeType: params.mimeType,
      contentKind: params.contentKind,
      sizeBytes: String(params.sizeBytes),
      uploaderUserId: params.uploaderUserId,
      initiatorActorId: params.initiatorActorId,
      sourceFamily: params.sourceFamily,
      sourceSystem: params.sourceSystem,
      parentAssetId: params.parentAssetId,
      detailsJson: toFileAssetDetailsJson(params.details),
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
}

export async function persistLocalCasFileAsset(
  input: PersistLocalCasFileInput
): Promise<PersistedStoredFileAsset> {
  return db.transaction().execute(async (trx) => {
    await upsertContentBlob(trx, {
      sha256: input.contentSha256,
      sizeBytes: input.sizeBytes,
      backend: input.backend,
    })

    const asset = await insertFileAsset(trx, input)

    return {
      ...asset,
      sizeBytes: Number(asset.sizeBytes),
      storageBackend: input.backend,
    }
  })
}
