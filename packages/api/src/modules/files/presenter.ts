import {
  requireInstantDate,
  serializeInstant,
} from "../../infrastructure/datetime.js"
import { parseJsonObject, type FileRecordView } from "@synapse/shared"
import {
  getStableFileUrl,
  getStableFullFileUrl,
} from "../../infrastructure/storage/index.js"
import {
  toFileOriginSummary,
  type FileOriginInput,
  type StoredFileRecord,
} from "./model.js"

export type FileJoinRow = {
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

export function presentFileAsset(row: FileJoinRow): StoredFileRecord {
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
