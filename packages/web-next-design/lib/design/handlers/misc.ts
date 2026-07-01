import { AuditLogListViewSchema } from "@synapse/shared/schemas"
import { mock } from "../faker-setup"
import { designUploadedFile } from "../fixtures/files"
import type { DesignHandlers } from "./_types"

// Cross-cutting odds and ends: the workspace audit-log feed and the file
// upload / info endpoints. The file record schemas carry a z.custom field that
// crashes zod-schema-faker, so upload/info return a curated record instead.
export const miscHandlers = {
  getAuditLogs: async () => mock(AuditLogListViewSchema),
  uploadFile: async () => designUploadedFile(),
  getFileInfo: async () => designUploadedFile(),
} satisfies DesignHandlers
