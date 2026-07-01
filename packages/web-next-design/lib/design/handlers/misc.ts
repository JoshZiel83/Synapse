import {
  AuditLogListViewSchema,
  StoredFileRecordViewSchema,
  FileRecordViewSchema,
} from "@synapse/shared/schemas"
import { mock } from "../faker-setup"
import type { DesignHandlers } from "./_types"

// Cross-cutting odds and ends: the workspace audit-log feed and the file
// upload / info endpoints. These back the audit page and any attachment UI.
export const miscHandlers = {
  getAuditLogs: async () => mock(AuditLogListViewSchema),
  uploadFile: async () => mock(StoredFileRecordViewSchema),
  // Re-enabled after the RC3 fix (b9647863): FileRecordViewSchema's
  // originSummary.system now infers the FileOriginSystem union (not string),
  // matching the hand-written FileRecordView (see contract-parity.ts).
  getFileInfo: async () => mock(FileRecordViewSchema),
} satisfies DesignHandlers
