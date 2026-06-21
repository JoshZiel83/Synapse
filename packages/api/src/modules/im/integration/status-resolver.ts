/**
 * Pure: derive a StatusLevel from an actor lifecycle event payload.
 *
 * The events come from packages/api/src/infrastructure/events:
 *  - `actor.thinking` (turn start)
 *  - `actor.action` (tool calls issued / turn complete)
 *  - `runtime.updated` (phase / lane / health transitions; replaced the old
 *     session.thinking and session.status.changed events removed in S13)
 *
 * Returns null for events we should ignore (e.g. an `actor.action` with no
 * tool calls is treated as "completion" by the caller, not via this resolver).
 */

import { ACTOR_RUNTIME_HEALTH } from "@synapse/shared"
import {
  isTerminalStatus,
  pickDominantToolStatus,
  resolveToolStatusLevel,
  type StatusLevel,
} from "../messaging/status-emojis.js"

/**
 * Pick the first string-valued name field on an action object, in priority
 * order (tool → name → kind), falling back to "" when none is present.
 */
function pickActionName(obj: Record<string, unknown>): string {
  if (typeof obj.tool === "string") return obj.tool
  if (typeof obj.name === "string") return obj.name
  if (typeof obj.kind === "string") return obj.kind
  return ""
}

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
    const candidate = pickActionName(obj)
    if (candidate) names.push(candidate)
  }
  if (names.length === 0) return null
  return pickDominantToolStatus(names)
}

/**
 * Inspect a free-form phase/status payload (originally for the now-removed
 * `session.thinking` event; kept as a general-purpose status-text → level
 * mapper). Returns the most appropriate StatusLevel, defaulting to "thinking".
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

/**
 * Map an ActorRuntimePhase value (carried by `runtime.updated` snapshots) to
 * the StatusLevel the reaction controller renders.
 *
 * Returns null for phases the reaction controller should not change to
 * mid-flight: "idle" / "error" terminal handling lives in the runtime.updated
 * handler itself (they trigger reaction.done() / reaction.error() with full
 * cleanup); "blocked" is a wait state where the previously-displayed reaction
 * should remain visible.
 */
export function resolveRuntimePhaseStatus(phase: string): StatusLevel | null {
  switch (phase) {
    case "thinking":
      return "thinking"
    case "tool":
      return "tool"
    case "responding":
      return "coding"
    default:
      return null
  }
}

/**
 * What the `runtime.updated` handler should do for a given snapshot, expressed
 * as a tagged union so it can be unit-tested without spinning up the full
 * event bus or controller graph.
 *
 *  - terminal-error: hard failure path (lastError, blocked-with-error, etc.).
 *    The handler should call reaction.error() + typing.stop() and schedule
 *    cleanup.
 *  - terminal-done: clean completion. Same as terminal-error but reaction.done().
 *  - set-level: in-flight phase update — reaction.set(level) + typing.stop()
 *    (the snapshot is the first sign of actual server-side activity, so any
 *    lingering "typing…" indicator should yield to the reaction).
 *  - noop: snapshot has no actionable phase/lane/health change for IM (e.g.
 *    laneState="queued" + phase="idle" follow-up-pending, or laneState="running"
 *    + phase="blocked" wait state).
 *
 * Behavior tables encoded here:
 *   health === ACTOR_RUNTIME_HEALTH.ERROR          → terminal-error
 *   laneState === "closed"                          → terminal-error
 *   phase === "error" AND (health === ACTOR_RUNTIME_HEALTH.ERROR
 *     OR laneState ∈ {"blocked","closed"})         → terminal-error
 *   laneState === "idle" AND phase === "idle"       → terminal-done
 *   phase ∈ {"thinking","tool","responding"}        → set-level
 *   everything else (incl. laneState="queued", phase="blocked", phase="idle"
 *     while laneState != "idle", and the inherited
 *     "queued + ok + stale error phase" case)       → noop
 *
 * Why phase="error" alone is NOT terminal: the runtime snapshot builder in
 * packages/api/src/modules/session/runtime.ts inherits cached fields
 * (phase, statusText, lastError) from the previous snapshot when laneState
 * stays in {running, queued, blocked} and the publisher doesn't supply an
 * override. enqueueSessionWakeup() now defends against this by explicitly
 * passing {phase: "idle", lastError: null, statusText: null} on the
 * requeue-from-blocked path, but the runtime contract on the receiving end
 * cannot rely on every future publisher being equally disciplined —
 * any caller that forgets to override phase while transitioning out of an
 * "error" cache would leak phase="error" into a perfectly healthy
 * queued/running snapshot. Treating that bare phase as terminal would
 * tear down the IM controllers right when the next turn is about to start,
 * so we require a corroborating health/laneState signal before believing
 * it. The accompanying snapshot-level regression test
 * (tests/integration/session-runtime-snapshot.test.ts) locks the
 * inheritance behavior, and the decision-table tests here lock this
 * receiver-side defense.
 */
export type RuntimeUpdateDecision =
  | { kind: "terminal-error" }
  | { kind: "terminal-done" }
  | { kind: "set-level"; level: StatusLevel }
  | { kind: "noop" }

export function decideRuntimeUpdateAction(snapshot: {
  laneState?: unknown
  health?: unknown
  phase?: unknown
}): RuntimeUpdateDecision {
  const laneState = String(snapshot.laneState || "")
  const health = String(snapshot.health || "")
  const phase = String(snapshot.phase || "")

  if (health === ACTOR_RUNTIME_HEALTH.ERROR || laneState === "closed") {
    return { kind: "terminal-error" }
  }
  // phase="error" alone is unreliable — it can be inherited from a stale
  // Redis cache when a previously-blocked session is re-enqueued without
  // an explicit phase override (see file header). Only treat as terminal
  // when corroborated by health or laneState.
  if (
    phase === "error" &&
    (health === ACTOR_RUNTIME_HEALTH.ERROR ||
      laneState === "blocked" ||
      laneState === "closed")
  ) {
    return { kind: "terminal-error" }
  }
  if (laneState === "idle" && phase === "idle") {
    return { kind: "terminal-done" }
  }
  const level = resolveRuntimePhaseStatus(phase)
  if (level !== null) {
    return { kind: "set-level", level }
  }
  return { kind: "noop" }
}

/** True if a status level represents a terminal state. */
export { isTerminalStatus }
