import { z } from "zod"
import {
  RELAY_AUTHORIZATION_COMMAND_EXECUTORS,
  RELAY_AUTHORIZATION_COMMAND_MATCH_TYPES,
} from "../../constants/enums.js"

export const CommandlinePolicySchema = z.object({
  executor: z.enum(RELAY_AUTHORIZATION_COMMAND_EXECUTORS),
  commandMatchType: z.enum(RELAY_AUTHORIZATION_COMMAND_MATCH_TYPES),
  commandText: z.string().optional(),
  workingDirectory: z.string().optional(),
})

export type CommandlinePolicy = z.infer<typeof CommandlinePolicySchema>
