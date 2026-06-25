import { z } from "zod"
import { ACTOR_DOC_VISIBILITIES } from "../constants/enums.js"
import { PersistedCanonicalContentBlockSchema } from "./chat-content-block.js"

const actorDocShape = {
  key: z.string(),
  title: z.string(),
  content: z.array(PersistedCanonicalContentBlockSchema),
  visibility: z.enum(ACTOR_DOC_VISIBILITIES),
  priority: z.number(),
}

// Actor-doc ids are stable string identifiers, NOT necessarily UUIDs: seeded
// official-template docs use slug-based ids (e.g. "<slug>:identity-card") and
// normalizeActorDocs preserves any non-empty string id, only minting a UUID
// when one is absent. Modeling id as z.uuid() rejected those real docs and
// 400'd every actor-definition-serving endpoint (workspace create, org actor
// views/versions/snapshots). The id is an opaque identifier here, not a UUID.
export const ActorDocSchema = z.object({
  id: z.string().min(1),
  ...actorDocShape,
})

export const ActorDocInputSchema = z.object({
  id: z.string().min(1).optional(),
  ...actorDocShape,
})
