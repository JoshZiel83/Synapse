import { designUploadedFile } from "../fixtures/files"
import type { DesignHandlers } from "./_types"

// Cross-cutting odds and ends: the file upload / info endpoints. The file
// record schemas carry a z.custom field that crashes zod-schema-faker, so
// upload/info return a curated record instead.
export const miscHandlers = {
  uploadFile: async () => designUploadedFile(),
  getFileInfo: async () => designUploadedFile(),
} satisfies DesignHandlers
