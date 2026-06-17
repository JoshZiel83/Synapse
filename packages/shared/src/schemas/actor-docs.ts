import { z } from "zod"
import { ACTOR_DOC_VISIBILITIES } from "../constants/enums.js"
import { CanonicalContentBlockSchema } from "./chat-content-block.js"

const actorDocShape = {
  key: z.string(),
  title: z.string(),
  content: z.array(CanonicalContentBlockSchema),
  visibility: z.enum(ACTOR_DOC_VISIBILITIES),
  priority: z.number(),
}

export const ActorDocSchema = z.object({
  id: z.uuid(),
  ...actorDocShape,
})

export const ActorDocInputSchema = z.object({
  id: z.uuid().optional(),
  ...actorDocShape,
})
