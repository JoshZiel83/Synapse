// Curated uploaded-file record. `mock(StoredFileRecordViewSchema)` crashes
// zod-schema-faker (the schema's originSummary.details is a z.custom the faker
// can't synthesize → "E.get is not a function"), so uploadFile is hand-authored.
// details is optional, so omitting it sidesteps the crash.
import type { StoredFileRecordView } from "@synapse/shared/schemas"
import { dateToIsoInstant } from "@synapse/shared/datetime"
import { designUserId, designWorkspaceId } from "./identity"

let seq = 0

export function designUploadedFile(
  over: Partial<StoredFileRecordView> = {}
): StoredFileRecordView {
  seq += 1
  const id = `file-${seq}`
  return {
    id,
    assetId: `asset-${seq}`,
    workspaceId: designWorkspaceId,
    uploaderUserId: designUserId,
    originalName: "上传文件.pdf",
    url: `/api/v1/content/${id}`,
    fullUrl: `/api/v1/content/${id}`,
    mimeType: "application/pdf",
    contentKind: "document",
    sizeBytes: 1_240_000,
    sha256: "0".repeat(64),
    storageBackend: "local",
    originSummary: { family: "user_upload", system: "workspace_web_upload" },
    createdAt: dateToIsoInstant(new Date("2026-06-30T12:00:00Z")),
    ...over,
  }
}
