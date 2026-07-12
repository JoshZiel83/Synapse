import { z } from "zod"
import { IsoInstantStringSchema } from "./datetime.js"
import {
  CANONICAL_FILE_CATEGORIES,
  FILE_ORIGIN_FAMILIES,
  FILE_ORIGIN_SYSTEMS,
  FILE_PARSE_OUTPUT_KINDS,
  FILE_PARSE_RUN_STATUSES,
  USER_UPLOAD_FILE_ORIGIN_SYSTEMS,
} from "../constants/enums.js"
import type { FileOriginSummary, FileOriginSystem } from "../types/index.js"

/**
 * App-facing contracts for the files module's APP routes (master plan §5.3).
 * Workspace-scoped / authenticated reads + the user upload write are wrapped
 * through `sendData` → `{ data: ... }`, so each response value is modeled by a
 * shared camelCase schema here. Binary downloads (GET /files/:fileId,
 * GET /content/:sha256) stay WIRE routes and are NOT modeled here.
 *
 * These schemas describe the values the handlers return — the API-side
 * camelCase presenter output (`FileRecordView` / `StoredFileRecord` /
 * `FileParseRunView`). Top-level identity + lifecycle fields are modeled
 * explicitly; genuinely-open nested payloads (origin `details`, parse-output
 * `structuredJson`) are modeled as open records.
 */

// Cast to the literal-union tuple (not `[string, ...]`) so `z.enum(...)` below
// infers the FileOriginSystem union, not `string` — keeping the schema's
// `originSummary.system` aligned with the hand-written FileOriginSummary.system.
const FILE_ORIGIN_SYSTEM_VALUES = Object.values(FILE_ORIGIN_SYSTEMS) as [
  FileOriginSystem,
  ...FileOriginSystem[],
]
const fileOriginSummaryDetailsSchema = z.custom<
  NonNullable<FileOriginSummary["details"]>
>(
  (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
)

/** Multipart `origin` field for app-facing user uploads. */
export const FileUploadOriginInputSchema = z.strictObject({
  family: z.literal("user_upload"),
  system: z.enum(USER_UPLOAD_FILE_ORIGIN_SYSTEMS),
  details: z.record(z.string(), z.unknown()).optional(),
})
export type FileUploadOriginInput = z.infer<typeof FileUploadOriginInputSchema>

/** Origin provenance summary attached to every presented file record. */
export const FileOriginSummaryViewSchema = z.object({
  family: z.enum(FILE_ORIGIN_FAMILIES),
  system: z.enum(FILE_ORIGIN_SYSTEM_VALUES),
  initiatorUserId: z.string().nullish(),
  initiatorActorId: z.string().nullish(),
  providerKey: z.string().optional(),
  parentFileId: z.string().nullish(),
  externalResourceKey: z.string().optional(),
  // Genuinely-open metadata bag (ToolResultOrigin snapshot); no fixed schema.
  details: fileOriginSummaryDetailsSchema.optional(),
})
export type FileOriginSummaryView = z.infer<typeof FileOriginSummaryViewSchema>

/** Presented file record (camelCase). Mirrors the shared FileRecordView. */
export const FileRecordViewSchema = z.object({
  id: z.string(),
  workspaceId: z.string().nullish(),
  uploaderUserId: z.string().nullish(),
  originalName: z.string(),
  url: z.string(),
  fullUrl: z.string(),
  mimeType: z.string(),
  contentKind: z.enum(CANONICAL_FILE_CATEGORIES),
  sizeBytes: z.number(),
  sha256: z.string(),
  // Opaque, deployment-config-driven backend id (plan §7#4): the wire carries
  // it as a plain string, not a frozen enum, so a real non-local backend
  // serializes without a schema/migration change.
  storageBackend: z.string(),
  originSummary: FileOriginSummaryViewSchema,
  createdAt: IsoInstantStringSchema,
})
export type FileRecordViewSchemaType = z.infer<typeof FileRecordViewSchema>

/**
 * Stored file record returned by the upload write — FileRecordView plus
 * `assetId` (mirrors `id` for callers that referenced the asset row id).
 */
export const StoredFileRecordViewSchema = FileRecordViewSchema.extend({
  assetId: z.string(),
})
export type StoredFileRecordView = z.infer<typeof StoredFileRecordViewSchema>

/** A single parse-run output (extracted text / structured json / derived file). */
export const FileParseOutputViewSchema = z.object({
  id: z.string(),
  outputKind: z.enum(FILE_PARSE_OUTPUT_KINDS),
  role: z.string(),
  isPrimary: z.boolean(),
  textContent: z.string().optional(),
  // Genuinely-open parser metadata payload.
  structuredJson: z.record(z.string(), z.unknown()).optional(),
  derivedFileId: z.string().nullish(),
  derivedFile: FileRecordViewSchema.optional(),
  createdAt: IsoInstantStringSchema,
})
export type FileParseOutputViewSchemaType = z.infer<
  typeof FileParseOutputViewSchema
>

/** A hydrated file parse run (the latest available parse for a file). */
export const FileParseRunViewSchema = z.object({
  id: z.string(),
  fileId: z.string(),
  pipeline: z.string(),
  parserKey: z.string(),
  parserVersion: z.string().nullish(),
  trigger: z.string(),
  status: z.enum(FILE_PARSE_RUN_STATUSES),
  errorCode: z.string().nullish(),
  errorMessage: z.string().nullish(),
  createdAt: IsoInstantStringSchema,
  startedAt: IsoInstantStringSchema.nullish(),
  finishedAt: IsoInstantStringSchema.nullish(),
  outputs: z.array(FileParseOutputViewSchema),
})
export type FileParseRunViewSchemaType = z.infer<typeof FileParseRunViewSchema>

/** Result of manually enqueueing a parse run (POST /files/:fileId/parses). */
export const FileParseEnqueueResultSchema = z.object({
  runId: z.string(),
})
export type FileParseEnqueueResult = z.infer<
  typeof FileParseEnqueueResultSchema
>
