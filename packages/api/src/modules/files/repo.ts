// files/repo.ts — DB-touching reads for the files module.
//
// The only file-service-side file permitted to import the db client (guard r8).
// Owns the file-asset join read, the best-effort content-MIME lookup, and the
// workspace-access check. Returns camelCase domain rows with Date objects KEPT
// (Date→ISO serialization stays in presenter.ts per r3). round-6 P1-6.

import { db } from "../../infrastructure/database/kysely.js"
import type { FileJoinRow } from "./presenter.js"

export type FileAssetDbRow = Omit<FileJoinRow, "details"> & {
  detailsJson: unknown
}

export function normalizeFileAssetJoinRow(row: FileAssetDbRow): FileJoinRow {
  const { detailsJson, ...rest } = row
  return {
    ...rest,
    details: parseFileAssetDetails(detailsJson),
  }
}

function parseFileAssetDetails(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {}
  const parsed = typeof value === "string" ? parseFileAssetJson(value) : value
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("file asset detailsJson must be a JSON object")
  }
  return parsed as Record<string, unknown>
}

function parseFileAssetJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new Error("file asset detailsJson must be valid JSON")
  }
}

export async function getFileAssetJoinRow(
  fileId: string,
  workspaceId?: string
): Promise<FileJoinRow | null> {
  // file_assets folds in the old file_origins columns; join content_blobs only
  // to surface the per-blob storage backend (plan §6.4) — the blob row always
  // exists (FK content_sha256 → content_blobs), so the left join never drops f.
  let query = db
    .selectFrom("fileAssets as f")
    .leftJoin("contentBlobs as cb", "cb.sha256", "f.contentSha256")
    .select([
      "f.id",
      "f.workspaceId",
      "f.uploaderUserId",
      "f.originalName",
      "f.mimeType",
      "f.contentKind",
      "f.sizeBytes",
      "f.contentSha256",
      "f.createdAt",
      "f.sourceFamily",
      "f.sourceSystem",
      "f.initiatorActorId",
      "f.parentAssetId",
      "f.detailsJson",
      "cb.backend",
    ])
    .where("f.id", "=", fileId)

  if (workspaceId) {
    query = query.where("f.workspaceId", "=", workspaceId)
  }

  const row = (await query.executeTakeFirst()) as FileAssetDbRow | undefined
  return row ? normalizeFileAssetJoinRow(row) : null
}

/**
 * Best-effort MIME for a content blob. content_blobs deliberately stores no MIME
 * (the same sha can be presented as different MIME in different contexts), so we
 * read it back from whatever references the sha: an entity asset, or any file_ref
 * part that carries a mime_type. Falls back to application/octet-stream.
 */
export async function getContentMimeBySha(sha256: string): Promise<string> {
  const asset = await db
    .selectFrom("fileAssets")
    .select("mimeType")
    .where("contentSha256", "=", sha256)
    .limit(1)
    .executeTakeFirst()
  if (asset?.mimeType) return asset.mimeType

  const part = await db
    .selectFrom("conversationItemParts")
    .select("mimeType")
    .where("refSha256", "=", sha256)
    .where("mimeType", "is not", null)
    .limit(1)
    .executeTakeFirst()
  if (part?.mimeType) return part.mimeType

  const toolPart = await db
    .selectFrom("toolResultParts")
    .select("mimeType")
    .where("refSha256", "=", sha256)
    .where("mimeType", "is not", null)
    .limit(1)
    .executeTakeFirst()
  if (toolPart?.mimeType) return toolPart.mimeType

  return "application/octet-stream"
}

export async function canUserAccessFileWorkspace(
  workspaceId: string | null,
  userId: string
): Promise<boolean> {
  if (!workspaceId) return true

  const row = await db
    .selectFrom("workspaces as w")
    .leftJoin("workspaceMembers as wm", (join) =>
      join
        .onRef("wm.workspaceId", "=", "w.id")
        .on("wm.userId", "=", userId)
        // Only an active membership counts (not 'left'/'removed').
        .on("wm.status", "=", "active")
    )
    .select("w.id")
    .where("w.id", "=", workspaceId)
    // A soft-deleted workspace grants no access to its files.
    .where("w.deletedAt", "is", null)
    .where((eb) =>
      eb.or([eb("w.ownerId", "=", userId), eb("wm.userId", "is not", null)])
    )
    .limit(1)
    .executeTakeFirst()

  return Boolean(row)
}
