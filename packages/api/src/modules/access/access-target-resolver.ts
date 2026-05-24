/**
 * Async resolver: takes an application-layer AccessTarget (workspace /
 * conversation / actor / actor_in_conversation) and resolves it into the
 * concrete AccessGrantTarget shape. The actor_in_conversation case requires
 * looking up or creating a conversation_actor_context, hence the dependency
 * on session/service.
 *
 * Lives in its own file (instead of bindings.ts) so that the pure-function
 * decoders / encoders can be imported in tests without triggering the heavy
 * session/service transitive load chain.
 */

import type { AccessTarget } from "@synapse/shared/types"
import { ensureConversationActorContext } from "../session/service.js"
import type { AccessGrantTarget } from "./bindings.js"

export async function resolveAccessGrantTarget(input: {
  workspaceId: string
  target: AccessTarget
}): Promise<AccessGrantTarget> {
  switch (input.target.type) {
    case "workspace":
      return {
        targetType: "workspace",
        subjectWorkspaceId: input.workspaceId,
        subjectWorkspaceMemberId: null,
        subjectActorId: null,
        subjectConversationId: null,
        subjectConversationActorContextId: null,
      }
    case "conversation":
      if (!input.target.conversationId) {
        throw new Error("conversationId is required for conversation target")
      }
      return {
        targetType: "conversation",
        subjectWorkspaceId: null,
        subjectWorkspaceMemberId: null,
        subjectActorId: null,
        subjectConversationId: input.target.conversationId,
        subjectConversationActorContextId: null,
      }
    case "actor":
      if (!input.target.actorId) {
        throw new Error("actorId is required for actor target")
      }
      return {
        targetType: "actor",
        subjectWorkspaceId: null,
        subjectWorkspaceMemberId: null,
        subjectActorId: input.target.actorId,
        subjectConversationId: null,
        subjectConversationActorContextId: null,
      }
    case "actor_in_conversation": {
      if (!input.target.actorId || !input.target.conversationId) {
        throw new Error(
          "actorId and conversationId are required for actor_in_conversation target"
        )
      }
      const context = await ensureConversationActorContext({
        actorId: input.target.actorId,
        conversationId: input.target.conversationId,
      })
      return {
        targetType: "actor_in_conversation",
        subjectWorkspaceId: null,
        subjectWorkspaceMemberId: null,
        subjectActorId: input.target.actorId,
        subjectConversationId: input.target.conversationId,
        subjectConversationActorContextId: context.conversationActorContextId,
      }
    }
    case "workspace_member":
      if (!input.target.workspaceMemberId) {
        throw new Error(
          "workspaceMemberId is required for workspace_member target"
        )
      }
      return {
        targetType: "workspace_member",
        subjectWorkspaceId: null,
        subjectWorkspaceMemberId: input.target.workspaceMemberId,
        subjectActorId: null,
        subjectConversationId: null,
        subjectConversationActorContextId: null,
      }
    default:
      throw new Error(
        `Unsupported access target type: ${String(input.target.type)}`
      )
  }
}
