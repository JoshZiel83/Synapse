import { z } from "zod"
import { RELAY_AUTHORIZATION_CUA_ACCESSES } from "../../constants/enums.js"

export const CUAPolicySchema = z.object({
  access: z.enum(RELAY_AUTHORIZATION_CUA_ACCESSES),
})

export type CUAPolicy = z.infer<typeof CUAPolicySchema>
