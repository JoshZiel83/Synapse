/**
 * Pure: derive a StatusLevel from an actor lifecycle event payload.
 *
 * The events come from packages/api/src/infrastructure/events: `actor.thinking`
 * (turn start), `session.thinking` (phase changes), `actor.action` (tool calls
 * issued / turn complete).
 *
 * Returns null for events we should ignore (e.g. an `actor.action` with no
 * tool calls is treated as "completion" by the caller, not via this resolver).
 */

import {
  isTerminalStatus,
  pickDominantToolStatus,
  resolveToolStatusLevel,
  type StatusLevel,
} from "../messaging/status-emojis.js"

/**
 * Inspect an `actor.action` payload's `actions` array and pick the dominant
 * status level. Returns null when no actions are present (caller likely
 * wants to interpret as done).
 */
export function resolveActorActionStatus(
  payload: Record<string, unknown>
): StatusLevel | null {
  const actions = Array.isArray(payload.actions) ? payload.actions : []
  if (actions.length === 0) return null
  const names: string[] = []
  for (const a of actions) {
    if (!a || typeof a !== "object") continue
    const obj = a as Record<string, unknown>
    const candidate =
      typeof obj.tool === "string"
        ? obj.tool
        : typeof obj.name === "string"
          ? obj.name
          : typeof obj.kind === "string"
            ? obj.kind
            : ""
    if (candidate) names.push(candidate)
  }
  if (names.length === 0) return null
  return pickDominantToolStatus(names)
}

/**
 * Inspect a `session.thinking` payload's `status` / `phase` fields.
 * Returns the most appropriate StatusLevel, defaulting to "thinking".
 */
export function resolveSessionThinkingStatus(
  payload: Record<string, unknown>
): StatusLevel {
  const phase =
    typeof payload.phase === "string" ? payload.phase.toLowerCase() : ""
  const status =
    typeof payload.status === "string" ? payload.status.toLowerCase() : ""
  // Heuristics on phase first
  if (phase === "tool" || phase === "tooling") return "tool"
  if (phase === "coding" || phase === "writing") return "coding"
  if (phase === "web") return "web"
  if (phase === "done") return "done"
  if (phase === "error") return "error"
  // Then on status text
  if (status.includes("tool") || status.includes("invok"))
    return resolveToolStatusLevel(status)
  if (status.includes("coding") || status.includes("editing")) return "coding"
  if (status.includes("search") || status.includes("fetch")) return "web"
  return "thinking"
}

/** True if a status level represents a terminal state. */
export { isTerminalStatus }
