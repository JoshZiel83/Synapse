import { z } from "zod"
import { EVENT_TYPES } from "../constants/enums.js"

export const SystemEventSchema = z.object({
  type: z.enum(EVENT_TYPES),
  workspaceId: z.uuid(),
  recipientWorkspaceMemberId: z.uuid().optional(),
  payload: z.record(z.string(), z.unknown()),
  timestamp: z.string(),
})
