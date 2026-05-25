import { z } from "zod"
import {
  RUNTIME_AUTHORIZATION_COMMAND_EXECUTORS,
  RUNTIME_AUTHORIZATION_COMMAND_MATCH_TYPES,
} from "../../constants/enums.js"

export const CommandlinePolicySchema = z.object({
  executor: z.enum(RUNTIME_AUTHORIZATION_COMMAND_EXECUTORS),
  commandMatchType: z.enum(RUNTIME_AUTHORIZATION_COMMAND_MATCH_TYPES),
  commandText: z.string().optional(),
  workingDirectory: z.string().optional(),
})

export type CommandlinePolicy = z.infer<typeof CommandlinePolicySchema>
