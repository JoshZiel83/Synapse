import type { ActorAction, ThinkingResult } from "@synapse/shared"

export type AssistantSessionMessagePersistence =
  | {
      kind: "respond"
      actions: ActorAction[]
    }
  | {
      kind: "silent_actions"
      actionNames: string[]
    }
  | {
      kind: "none"
    }

export function getAssistantSessionMessagePersistence(
  result: Pick<ThinkingResult, "actions">
): AssistantSessionMessagePersistence {
  const respondActions = result.actions.filter(
    (action) => action.type === "respond"
  )
  if (respondActions.length > 0) {
    return {
      kind: "respond",
      actions: respondActions,
    }
  }

  if (result.actions.length > 0) {
    return {
      kind: "silent_actions",
      actionNames: result.actions.map((action) => action.type),
    }
  }

  return { kind: "none" }
}
