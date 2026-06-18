import type {
  Executor,
  TableInsert,
} from "../../infrastructure/database/kysely.js"

type FileAssetDetailsJson = TableInsert<"fileAssets">["detailsJson"]
type FileAssetInsert = TableInsert<"fileAssets">

export type AvatarFileAssetInsert = {
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

function toFileAssetDetailsJson(
  value: Record<string, unknown>
): FileAssetDetailsJson {
  return value as FileAssetDetailsJson
}

export async function insertAvatarFileAsset(
  executor: Executor,
  params: AvatarFileAssetInsert
): Promise<{ id: string }> {
  const row = await executor
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
    .returning("id")
    .executeTakeFirst()

  if (!row) {
    throw new Error("Failed to persist avatar file")
  }
  return row
}
