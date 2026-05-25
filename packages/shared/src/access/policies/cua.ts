import { z } from "zod"
import { RUNTIME_AUTHORIZATION_CUA_ACCESSES } from "../../constants/enums.js"

export const CUAPolicySchema = z.object({
  access: z.enum(RUNTIME_AUTHORIZATION_CUA_ACCESSES),
})

export type CUAPolicy = z.infer<typeof CUAPolicySchema>
