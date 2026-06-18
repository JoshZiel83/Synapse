import {
  requireInstantDate,
  serializeInstant,
  serializeOptionalInstant,
} from "../../infrastructure/datetime.js"
import {
  type FileRecordView,
  type FileParseOutputView,
  type FileParseRunView,
} from "@synapse/shared"
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
  backend: string | null
  createdAt: Date | null
  sourceFamily: FileRecordView["originSummary"]["family"]
  sourceSystem: FileRecordView["originSummary"]["system"]
  initiatorActorId: string | null
  parentAssetId: string | null
  details: Record<string, unknown>
}

export function presentFileAsset(row: FileJoinRow): StoredFileRecord {
  const origin = {
    family: row.sourceFamily,
    system: row.sourceSystem,
    initiatorActorId: row.initiatorActorId,
    parentFileId: row.parentAssetId,
    details: row.details,
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
    // Per-blob storage backend (plan §6.4), joined from content_blobs. Null only
    // if the blob row is somehow absent → treat as local_cas.
    storageBackend: row.backend ?? "local_cas",
    originSummary: toFileOriginSummary(origin),
    createdAt: serializeInstant(
      requireInstantDate(row.createdAt, `file_assets.${row.id}.created_at`)
    ),
  }
}

// ─────────────────────────── file-parse presenters ───────────────────────────
// round-6 P1-7: the Date→ISO serialization for file-parse runs/outputs lives
// here (presenter), not in parse-service.ts (guard r3). The service still owns
// the DB reads + derived-file resolution; it hands these pure row→View
// transforms the already-read rows.

/** A file_parse_runs row (Dates kept) handed to presentFileParseRun. */
export type FileParseRunRow = {
  id: string
  assetId: string
  pipeline: string
  parserKey: string
  parserVersion: string | null
  trigger: string
  status: FileParseRunView["status"]
  errorCode: string | null
  errorMessage: string | null
  createdAt: Date | null
  startedAt: Date | null
  finishedAt: Date | null
}

/** A file_parse_outputs row (Dates kept) handed to presentFileParseOutput. */
export type FileParseOutputRow = {
  id: string
  runId: string
  outputKind: FileParseOutputView["outputKind"]
  role: string
  isPrimary: boolean
  textContent: string | null
  structuredJson?: Record<string, unknown>
  derivedAssetId: string | null
  createdAt: Date | null
}

/** Present a single parse-output row as its app View. `derivedFile` is resolved
 * by the caller (it needs a DB read) and injected so this stays pure. */
export function presentFileParseOutput(
  row: FileParseOutputRow,
  derivedFile?: FileRecordView
): FileParseOutputView {
  return {
    id: row.id,
    outputKind: row.outputKind,
    role: row.role,
    isPrimary: row.isPrimary,
    textContent: row.textContent ?? undefined,
    structuredJson: row.structuredJson,
    derivedFileId: row.derivedAssetId,
    derivedFile: row.derivedAssetId ? derivedFile : undefined,
    createdAt: serializeInstant(
      requireInstantDate(
        row.createdAt,
        `file_parse_outputs.${row.id}.created_at`
      )
    ),
  }
}

/** Present a parse-run row as its app View. `outputs` are already presented. */
export function presentFileParseRun(
  row: FileParseRunRow,
  outputs: FileParseOutputView[]
): FileParseRunView {
  return {
    id: row.id,
    fileId: row.assetId,
    pipeline: row.pipeline,
    parserKey: row.parserKey,
    parserVersion: row.parserVersion,
    trigger: row.trigger,
    status: row.status,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: serializeInstant(
      requireInstantDate(row.createdAt, `file_parse_runs.${row.id}.created_at`)
    ),
    startedAt: serializeOptionalInstant(row.startedAt) ?? null,
    finishedAt: serializeOptionalInstant(row.finishedAt) ?? null,
    outputs,
  }
}
