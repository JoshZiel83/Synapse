import type { FileStorageBackend } from "@synapse/shared/types"
import { db, type Executor, type TableInsert } from "../database/kysely.js"

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

type FileAssetDetailsJson = TableInsert<"fileAssets">["detailsJson"]

function toFileAssetDetailsJson(
  value: Record<string, unknown>
): FileAssetDetailsJson {
  return value as FileAssetDetailsJson
}

/**
 * The SINGLE content_blobs row-writer (plan §6.5#3) — replaces the former
 * storage/repo.ts `upsertContentBlob`, avatar/repo.ts `upsertAvatarContentBlob`
 * (hardcoded local_cas) and sandbox/repo-space.ts raw-SQL `ensureContentBlob`.
 * Takes the caller's `executor` so it joins the caller's transaction (the
 * sandbox commit ingests the blob row inside runInTx BEFORE appendSnapshot).
 *
 * No `locator_json` (dropped — key=f(sha), bucket/region live in the config
 * registry; plan §7). `durableConfirmedAt` defaults to NOW for local_cas (landed
 * == durable); remote callers pass it after the durable PUT confirms.
 */
export async function ensureContentBlob(
  executor: Executor,
  params: {
    sha256: string
    sizeBytes: number
    backend: FileStorageBackend
    durableConfirmedAt?: Date | null
  }
): Promise<void> {
  // Every CURRENT caller writes synchronously-confirmed-durable bytes (local
  // landed on disk, or an awaited successful remote PUT), so default to NOW for
  // any backend. The deferred axis-B push path (plan §9.2) passes NULL explicitly
  // and sets it after the durable PUT confirms.
  const durableConfirmedAt = params.durableConfirmedAt ?? new Date()
  await executor
    .insertInto("contentBlobs")
    .values({
      sha256: params.sha256,
      sizeBytes: String(params.sizeBytes),
      backend: params.backend,
      durableConfirmedAt,
    })
    .onConflict((oc) => oc.column("sha256").doNothing())
    .execute()
}

/** Read a blob's recorded backend (read-path dispatch, plan §6.1). A sha with no
 *  row is treated as local_cas (local-only cache blob not yet rowed). */
export async function getBlobBackend(
  sha256: string
): Promise<FileStorageBackend> {
  const row = await db
    .selectFrom("contentBlobs")
    .select("backend")
    .where("sha256", "=", sha256)
    .limit(1)
    .executeTakeFirst()
  return (row?.backend as FileStorageBackend | undefined) ?? "local_cas"
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
    await ensureContentBlob(trx, {
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
