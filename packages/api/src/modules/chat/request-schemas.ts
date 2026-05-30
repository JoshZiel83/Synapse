import { z } from "zod"

export const chatUuidSchema = z.uuid()

export const chatWorkspaceParamsSchema = z.object({
  workspaceId: chatUuidSchema,
})

export const chatClientInstanceParamsSchema = chatWorkspaceParamsSchema.extend({
  clientInstanceId: chatUuidSchema,
})

export const chatConversationParamsSchema = chatWorkspaceParamsSchema.extend({
  conversationId: chatUuidSchema,
})

export const chatActorRuntimeParamsSchema = chatConversationParamsSchema.extend(
  {
    actorId: chatUuidSchema,
    turnId: chatUuidSchema,
  }
)

export const chatInteractionParamsSchema = chatWorkspaceParamsSchema.extend({
  conversationId: chatUuidSchema,
  interactionId: chatUuidSchema,
})
