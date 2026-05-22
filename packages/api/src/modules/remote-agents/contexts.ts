import type { RemoteAgentRuntimeStateType } from "@synapse/shared"

export type RemoteAgentConversationContextRecord = {
  remoteAgentId: string
  conversationId: string
  runtimeKind: string | null
  runtimeSessionId: string | null
  runtimeState: RemoteAgentRuntimeStateType
  statusText: string | null
  activeInteractionId: string | null
  lastRunStartedAt: string | null
  lastRunFinishedAt: string | null
  lastActivityAt: string | null
  lastError: string | null
}

const ACTIVE_STATES: ReadonlySet<RemoteAgentRuntimeStateType> = new Set([
  "running",
  "waiting_user_input",
  "plan_drafting",
  "waiting_plan_approval",
])

function statePriority(state: RemoteAgentRuntimeStateType) {
  if (ACTIVE_STATES.has(state)) return 0
  if (state === "idle") return 1
  if (state === "error") return 2
  return 3
}

function lastActivityMs(value: string | null) {
  if (!value) return Number.NEGATIVE_INFINITY
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY
}

/**
 * Pick the conversation context that best represents the agent's "current" runtime state.
 * Mirrors the LATEST_CONVERSATION_CONTEXT_LATERAL ordering used in service.ts so the SQL
 * and TypeScript views agree.
 */
export function pickRepresentativeContext<
  T extends Pick<
    RemoteAgentConversationContextRecord,
    "runtimeState" | "lastActivityAt"
  >,
>(contexts: ReadonlyArray<T>): T | null {
  if (contexts.length === 0) return null
  let best: T | null = null
  let bestPriority = Number.POSITIVE_INFINITY
  let bestActivity = Number.NEGATIVE_INFINITY
  for (const ctx of contexts) {
    const priority = statePriority(ctx.runtimeState)
    const activity = lastActivityMs(ctx.lastActivityAt)
    if (priority < bestPriority) {
      best = ctx
      bestPriority = priority
      bestActivity = activity
      continue
    }
    if (priority === bestPriority && activity > bestActivity) {
      best = ctx
      bestActivity = activity
    }
  }
  return best
}

/**
 * Returns true if the server should emit `agent:start` for a (remote_agent, conversation)
 * pair on daemon (re)connect. Mirrors the WHERE clause in loadActiveConversationContextsForMachine.
 */
export function shouldDispatchAgentStart(input: {
  runtimeSessionId: string | null
  hasPendingDelivery: boolean
}) {
  return Boolean(input.runtimeSessionId) || input.hasPendingDelivery
}
