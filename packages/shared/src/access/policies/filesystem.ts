import { z } from "zod"
import { RELAY_AUTHORIZATION_FILESYSTEM_ACCESSES } from "../../constants/enums.js"

// P4: Zod schema is the single source of truth. The Go struct in
// relay/internal/runtimeauth/policies_gen.go is generated from this shape via
// scripts/codegen/relay-policies.ts. Do not edit field names without
// regenerating.
export const FilesystemPolicySchema = z.object({
  access: z.enum(RELAY_AUTHORIZATION_FILESYSTEM_ACCESSES),
  pathPrefixes: z.array(z.string()),
})

export type FilesystemPolicy = z.infer<typeof FilesystemPolicySchema>
