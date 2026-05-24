import { z } from "zod"
import {
  RELAY_AUTHORIZATION_BROWSER_ACTIONS,
  RELAY_AUTHORIZATION_BROWSER_SCOPE_TYPES,
} from "../../constants/enums.js"

// scopeType is optional on the wire (the Go side omits it when empty).
export const BrowserPolicySchema = z.object({
  action: z.enum(RELAY_AUTHORIZATION_BROWSER_ACTIONS),
  scopeType: z.enum(RELAY_AUTHORIZATION_BROWSER_SCOPE_TYPES).optional(),
  origin: z.string().optional(),
  host: z.string().optional(),
  registrableDomain: z.string().optional(),
})

export type BrowserPolicy = z.infer<typeof BrowserPolicySchema>
