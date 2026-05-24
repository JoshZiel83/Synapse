import { z } from "zod"
import { RELAY_AUTHORIZATION_CAPABILITIES } from "../../constants/enums.js"
import { FilesystemPolicySchema } from "./filesystem.js"
import { CUAPolicySchema } from "./cua.js"
import { BrowserPolicySchema } from "./browser.js"
import { CommandlinePolicySchema } from "./commandline.js"

// GrantPolicy mirrors the wire shape of a single grant spec. The Go side
// (relay/internal/runtimeauth/policies_gen.go) is generated from this schema;
// every per-capability sub-policy is optional so the matcher functions can
// route on `capability` plus the populated branch.
export const GrantPolicySchema = z.object({
  capability: z.enum(RELAY_AUTHORIZATION_CAPABILITIES),
  filesystem: FilesystemPolicySchema.optional(),
  cua: CUAPolicySchema.optional(),
  browser: BrowserPolicySchema.optional(),
  commandline: CommandlinePolicySchema.optional(),
})

export type GrantPolicy = z.infer<typeof GrantPolicySchema>
