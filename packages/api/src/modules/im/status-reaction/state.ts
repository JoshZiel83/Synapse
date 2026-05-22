/**
 * Pure-functional state machine for the StatusReactionController.
 *
 * Inputs: events (caller intent + adapter responses + timer ticks).
 * Outputs: new state + an Effect that the controller must perform.
 *
 * Why pure? Easy unit-test of all transitions without timers or async.
 * The controller wraps this reducer with Clock + Adapter + Promise chain.
 *
 * Lifecycle:
 *   idle ──set──> pending (waiting out debounce)
 *   pending ──debounce expires──> in_flight (calling adapter.setReaction)
 *   in_flight ──apply_finished──> idle (current = pending)
 *   any non-terminal ──done/error──> terminal_pending → terminal → cleared
 *   terminal ignores further set() (terminal-protection window)
 */

import {
  isStallStatus,
  isTerminalStatus,
  type StatusLevel,
} from "../messaging/status-emojis.js"

export interface StatusConfig {
  debounceMs: number
  doneHoldMs: number
  errorHoldMs: number
  stallSoftMs: number
  stallHardMs: number
}

export const DEFAULT_STATUS_CONFIG: StatusConfig = {
  debounceMs: 700,
  doneHoldMs: 1500,
  errorHoldMs: 2500,
  stallSoftMs: 10_000,
  stallHardMs: 30_000,
}

export type Phase =
  | "idle"
  | "pending"
  | "in_flight"
  | "terminal_hold"
  | "destroyed"

export interface StatusState {
  phase: Phase
  /** What's currently displayed on the platform (or null = no reaction). */
  currentLevel: StatusLevel | null
  /** What we want to display next (set by caller during pending). */
  desiredLevel: StatusLevel | null
  /** Set when phase === in_flight. */
  inFlightLevel: StatusLevel | null
  /** When the current pending-window started, used for debounce + stall checks. */
  pendingSince: number | null
  /** When the current displayed level was applied (used for stall detection). */
  currentLevelSince: number | null
  /**
   * Timestamp of the last "real" activity (non-stall set). Used to measure
   * how long the controller has been idle even across the stall→stall_hard
   * escalation. NOT reset when the controller itself promotes the level to
   * stall, only when the caller pushes a real status change.
   */
  lastActiveSince: number | null
  /** When terminal_hold started. */
  terminalSince: number | null
  /** Last terminal kind. */
  terminalKind: "done" | "error" | null
}

export const INITIAL_STATUS_STATE: StatusState = {
  phase: "idle",
  currentLevel: null,
  desiredLevel: null,
  inFlightLevel: null,
  pendingSince: null,
  currentLevelSince: null,
  lastActiveSince: null,
  terminalSince: null,
  terminalKind: null,
}

export type StatusEvent =
  | { type: "request_set"; level: StatusLevel; at: number }
  | { type: "apply_started"; at: number }
  | { type: "apply_finished"; at: number }
  | { type: "apply_failed"; at: number }
  | { type: "tick"; at: number }
  | { type: "destroy"; at: number }

export type StatusEffect =
  | { kind: "noop" }
  | { kind: "set_reaction"; level: StatusLevel }
  | { kind: "clear_reaction" }
  | { kind: "schedule_tick"; afterMs: number }

export interface StatusTransition {
  next: StatusState
  effect: StatusEffect
}

export function reduceStatus(
  state: StatusState,
  event: StatusEvent,
  cfg: StatusConfig = DEFAULT_STATUS_CONFIG
): StatusTransition {
  if (state.phase === "destroyed") {
    return { next: state, effect: { kind: "noop" } }
  }

  switch (event.type) {
    case "destroy": {
      return {
        next: { ...state, phase: "destroyed" },
        effect: state.currentLevel
          ? { kind: "clear_reaction" }
          : { kind: "noop" },
      }
    }

    case "request_set": {
      return handleRequestSet(state, event.level, event.at, cfg)
    }

    case "apply_started": {
      // Optimistic: no state change; phase already in_flight when we dispatched
      return { next: state, effect: { kind: "noop" } }
    }

    case "apply_finished": {
      return handleApplyFinished(state, event.at, cfg, /*ok*/ true)
    }

    case "apply_failed": {
      return handleApplyFinished(state, event.at, cfg, /*ok*/ false)
    }

    case "tick": {
      return handleTick(state, event.at, cfg)
    }
  }
}

function handleRequestSet(
  state: StatusState,
  level: StatusLevel,
  at: number,
  cfg: StatusConfig
): StatusTransition {
  const terminalRequested = isTerminalStatus(level)

  // Terminal protection: once in terminal_hold, only allow another terminal.
  if (state.phase === "terminal_hold" && !terminalRequested) {
    return { next: state, effect: { kind: "noop" } }
  }

  // If we are already displaying this level and nothing else is queued, no-op.
  if (
    !terminalRequested &&
    state.currentLevel === level &&
    state.phase !== "in_flight" &&
    state.desiredLevel === null
  ) {
    return { next: state, effect: { kind: "noop" } }
  }

  if (terminalRequested) {
    // Terminals jump straight to in_flight (no debounce, no coalesce)
    return {
      next: {
        ...state,
        phase: "in_flight",
        desiredLevel: null,
        pendingSince: null,
        inFlightLevel: level,
        lastActiveSince: at,
        terminalKind: level as "done" | "error",
        terminalSince: null,
      },
      effect: { kind: "set_reaction", level },
    }
  }

  // Non-terminal: coalesce within debounce window
  if (state.phase === "in_flight") {
    // Queue as desired; will be picked up when current in-flight finishes
    return {
      next: { ...state, desiredLevel: level, lastActiveSince: at },
      effect: { kind: "noop" },
    }
  }

  // Idle or pending: start/refresh pending window
  return {
    next: {
      ...state,
      phase: "pending",
      desiredLevel: level,
      pendingSince: at,
      lastActiveSince: at,
    },
    effect: { kind: "schedule_tick", afterMs: cfg.debounceMs },
  }
}

function handleApplyFinished(
  state: StatusState,
  at: number,
  cfg: StatusConfig,
  _ok: boolean
): StatusTransition {
  const applied = state.inFlightLevel
  const wasTerminal = applied !== null && isTerminalStatus(applied)

  const baseNext: StatusState = {
    ...state,
    currentLevel: applied,
    currentLevelSince: applied !== null ? at : state.currentLevelSince,
    inFlightLevel: null,
  }

  if (wasTerminal) {
    const hold = applied === "done" ? cfg.doneHoldMs : cfg.errorHoldMs
    return {
      next: {
        ...baseNext,
        phase: "terminal_hold",
        terminalSince: at,
        desiredLevel: null,
      },
      effect: { kind: "schedule_tick", afterMs: hold },
    }
  }

  // Non-terminal: if there's a queued desired level, kick off another apply
  if (state.desiredLevel !== null && state.desiredLevel !== applied) {
    return {
      next: {
        ...baseNext,
        phase: "in_flight",
        inFlightLevel: state.desiredLevel,
        desiredLevel: null,
        pendingSince: null,
      },
      effect: { kind: "set_reaction", level: state.desiredLevel },
    }
  }

  // Settled: schedule a stall check
  return {
    next: {
      ...baseNext,
      phase: "idle",
      desiredLevel: null,
      pendingSince: null,
    },
    effect: { kind: "schedule_tick", afterMs: cfg.stallSoftMs },
  }
}

function handleTick(
  state: StatusState,
  at: number,
  cfg: StatusConfig
): StatusTransition {
  // Terminal hold expired → clear
  if (state.phase === "terminal_hold" && state.terminalSince !== null) {
    const hold =
      state.terminalKind === "error" ? cfg.errorHoldMs : cfg.doneHoldMs
    if (at - state.terminalSince >= hold) {
      return {
        next: {
          ...state,
          phase: "destroyed",
          currentLevel: null,
        },
        effect: state.currentLevel
          ? { kind: "clear_reaction" }
          : { kind: "noop" },
      }
    }
    // Not yet expired
    return { next: state, effect: { kind: "noop" } }
  }

  // Debounce window: if we've been pending long enough, fire
  if (
    state.phase === "pending" &&
    state.pendingSince !== null &&
    at - state.pendingSince >= cfg.debounceMs
  ) {
    const level = state.desiredLevel
    if (level === null) {
      // Shouldn't happen, but normalize to idle
      return {
        next: { ...state, phase: "idle", pendingSince: null },
        effect: { kind: "noop" },
      }
    }
    return {
      next: {
        ...state,
        phase: "in_flight",
        inFlightLevel: level,
        desiredLevel: null,
        pendingSince: null,
      },
      effect: { kind: "set_reaction", level },
    }
  }

  // Stall ladder: when idle and not terminal, escalate by elapsed time since
  // the LAST caller-driven activity (lastActiveSince). The previous version
  // used currentLevelSince which gets reset when the controller itself
  // promotes to stall, leaving stall_hard unreachable. lastActiveSince is
  // only bumped by request_set, so the timer keeps ticking through
  // stall→stall_hard.
  if (
    state.phase === "idle" &&
    state.currentLevel !== null &&
    state.lastActiveSince !== null &&
    !isTerminalStatus(state.currentLevel)
  ) {
    const elapsed = at - state.lastActiveSince
    if (elapsed >= cfg.stallHardMs && state.currentLevel !== "stall_hard") {
      return {
        next: {
          ...state,
          phase: "in_flight",
          inFlightLevel: "stall_hard",
        },
        effect: { kind: "set_reaction", level: "stall_hard" },
      }
    }
    if (
      elapsed >= cfg.stallSoftMs &&
      state.currentLevel !== "stall" &&
      state.currentLevel !== "stall_hard"
    ) {
      return {
        next: {
          ...state,
          phase: "in_flight",
          inFlightLevel: "stall",
        },
        effect: { kind: "set_reaction", level: "stall" },
      }
    }
    // Still idle non-terminal — schedule the next tick to keep watching.
    if (elapsed < cfg.stallHardMs) {
      const nextDelay =
        elapsed < cfg.stallSoftMs
          ? cfg.stallSoftMs - elapsed
          : cfg.stallHardMs - elapsed
      return {
        next: state,
        effect: { kind: "schedule_tick", afterMs: Math.max(nextDelay, 100) },
      }
    }
  }

  return { next: state, effect: { kind: "noop" } }
}
