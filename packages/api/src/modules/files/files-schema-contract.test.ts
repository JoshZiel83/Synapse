import assert from "node:assert/strict"
import test from "node:test"
import { FILE_ORIGIN_SYSTEMS } from "@synapse/shared/constants"
import {
  FileParseEnqueueResultSchema,
  FileUploadOriginInputSchema,
  StoredFileRecordViewSchema,
} from "@synapse/shared/schemas"

const fileId = "00000000-0000-4000-8000-000000000001"
const workspaceId = "00000000-0000-4000-8000-000000000002"
const userId = "00000000-0000-4000-8000-000000000003"
const runId = "00000000-0000-4000-8000-000000000004"
const isoInstant = "2026-06-14T00:00:00.000Z"

function storedFileRecordFixture() {
  return {
    id: fileId,
    assetId: fileId,
    workspaceId,
    uploaderUserId: userId,
    originalName: "brief.pdf",
    url: `/api/v1/files/${fileId}`,
    fullUrl: `https://example.test/api/v1/files/${fileId}`,
    mimeType: "application/pdf",
    contentKind: "document",
    sizeBytes: 1024,
    sha256: "a".repeat(64),
    storageBackend: "local_cas",
    originSummary: {
      family: "user_upload",
      system: FILE_ORIGIN_SYSTEMS.WORKSPACE_WEB_UPLOAD,
      initiatorUserId: userId,
      initiatorActorId: null,
      parentFileId: null,
      details: { source: "composer" },
    },
    createdAt: isoInstant,
  }
}

test("FileUploadOriginInputSchema accepts app user upload origins", () => {
  assert.ok(
    FileUploadOriginInputSchema.safeParse({
      family: "user_upload",
      system: FILE_ORIGIN_SYSTEMS.WORKSPACE_WEB_UPLOAD,
      details: { source: "composer" },
    }).success
  )
  assert.ok(
    FileUploadOriginInputSchema.safeParse({
      family: "user_upload",
      system: FILE_ORIGIN_SYSTEMS.WORKSPACE_MOBILE_UPLOAD,
    }).success
  )
})

test("FileUploadOriginInputSchema rejects non-user-upload origins", () => {
  assert.equal(
    FileUploadOriginInputSchema.safeParse({
      family: "actor_output",
      system: FILE_ORIGIN_SYSTEMS.WORKSPACE_WEB_UPLOAD,
    }).success,
    false
  )
  assert.equal(
    FileUploadOriginInputSchema.safeParse({
      family: "user_upload",
      system: FILE_ORIGIN_SYSTEMS.ACTOR_TOOL_UPLOAD_FILE,
    }).success,
    false
  )
})

test("StoredFileRecordViewSchema validates upload app responses", () => {
  assert.ok(
    StoredFileRecordViewSchema.safeParse(storedFileRecordFixture()).success
  )

  assert.equal(
    StoredFileRecordViewSchema.safeParse({
      ...storedFileRecordFixture(),
      assetId: undefined,
    }).success,
    false
  )
})

test("FileParseEnqueueResultSchema validates parse enqueue app responses", () => {
  assert.ok(FileParseEnqueueResultSchema.safeParse({ runId }).success)
  assert.equal(
    FileParseEnqueueResultSchema.safeParse({ run_id: runId }).success,
    false
  )
})
