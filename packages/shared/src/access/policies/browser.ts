import { z } from "zod"
import {
  RUNTIME_AUTHORIZATION_BROWSER_ACTIONS,
  RUNTIME_AUTHORIZATION_BROWSER_OPERATIONS,
  RUNTIME_AUTHORIZATION_BROWSER_SCOPE_TYPES,
} from "../../constants/enums.js"

// scopeType is optional on the wire (the Go side omits it when empty).
//
// v3.1: `operations` is the operation-level allowlist consumed by
// `browserPolicyAllows`. The schema relies on zod's **default** object
// stripping — unknown keys like a stray `scopeSource` get silently dropped
// on parse. We do NOT make it strict (e.g. `z.strictObject`) because the
// approval path may copy the requested action's `scopeSource` into a default
// grant option; stripping keeps that flow from blowing up.
export const BrowserPolicySchema = z.object({
  action: z.enum(RUNTIME_AUTHORIZATION_BROWSER_ACTIONS),
  scopeType: z.enum(RUNTIME_AUTHORIZATION_BROWSER_SCOPE_TYPES).optional(),
  origin: z.string().optional(),
  host: z.string().optional(),
  registrableDomain: z.string().optional(),
  operations: z
    .array(z.enum(RUNTIME_AUTHORIZATION_BROWSER_OPERATIONS))
    .optional(),
})

export type BrowserPolicy = z.infer<typeof BrowserPolicySchema>
