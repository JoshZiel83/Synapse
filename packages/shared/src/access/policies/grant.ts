import { z } from "zod"
import { RUNTIME_AUTHORIZATION_CAPABILITIES } from "../../constants/enums.js"
import { FilesystemPolicySchema } from "./filesystem.js"
import { CUAPolicySchema } from "./cua.js"
import { BrowserPolicySchema } from "./browser.js"
import { CommandlinePolicySchema } from "./commandline.js"

// GrantPolicy mirrors the wire shape of a single grant spec. The shared
// matcher in `./matchers.ts` (used by both API + device runtime) is the
// canonical implementation; every per-capability sub-policy is optional
// so the matcher functions can route on `capability` plus the populated
// branch.
export const GrantPolicySchema = z.object({
  capability: z.enum(RUNTIME_AUTHORIZATION_CAPABILITIES),
  filesystem: FilesystemPolicySchema.optional(),
  cua: CUAPolicySchema.optional(),
  browser: BrowserPolicySchema.optional(),
  commandline: CommandlinePolicySchema.optional(),
})

export type GrantPolicy = z.infer<typeof GrantPolicySchema>
