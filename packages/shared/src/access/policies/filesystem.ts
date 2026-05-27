import { z } from "zod"
import { RUNTIME_AUTHORIZATION_FILESYSTEM_ACCESSES } from "../../constants/enums.js"

// Zod schema is the single source of truth. Authoritative matcher
// (used by both API + device runtime) lives in `./matchers.ts`.
export const FilesystemPolicySchema = z.object({
  access: z.enum(RUNTIME_AUTHORIZATION_FILESYSTEM_ACCESSES),
  pathPrefixes: z.array(z.string()),
})

export type FilesystemPolicy = z.infer<typeof FilesystemPolicySchema>
