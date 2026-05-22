/**
 * Pure reducer for the TypingController.
 *
 * Drives `TypingAdapter.start()` and `stop()` calls. Maintains:
 *   - idempotent stop (multiple stops don't trigger multiple sends)
 *   - heartbeat: re-send start every `heartbeatMs` while active (platforms
 *     expire the typing indicator after a few seconds)
 *   - TTL: force stop after `ttlMs` regardless of caller (avoid stuck typing)
 *   - failure guard: after `maxFailures` consecutive errors, self-stop
 */

export interface TypingConfig {
  heartbeatMs: number
  ttlMs: number
  maxFailures: number
}

export const DEFAULT_TYPING_CONFIG: TypingConfig = {
  heartbeatMs: 3_000,
  ttlMs: 60_000,
  maxFailures: 2,
}

export type TypingPhase =
  | "idle"
  | "starting"
  | "active"
  | "stopping"
  | "destroyed"

export interface TypingState {
  phase: TypingPhase
  startedAt: number | null
  lastHeartbeatAt: number | null
  consecutiveFailures: number
}

export const INITIAL_TYPING_STATE: TypingState = {
  phase: "idle",
  startedAt: null,
  lastHeartbeatAt: null,
  consecutiveFailures: 0,
}

export type TypingEvent =
  | { type: "request_start"; at: number }
  | { type: "request_stop"; at: number }
  | { type: "heartbeat_tick"; at: number }
  | { type: "send_ok"; at: number }
  | { type: "send_failed"; at: number }
  | { type: "ttl_check"; at: number }
  | { type: "destroy"; at: number }

export type TypingEffect =
  | { kind: "noop" }
  | { kind: "send"; op: "start" | "stop" }
  | { kind: "schedule_heartbeat"; afterMs: number }
  | { kind: "schedule_ttl"; afterMs: number }

export interface TypingTransition {
  next: TypingState
  effect: TypingEffect
}

export function reduceTyping(
  state: TypingState,
  event: TypingEvent,
  cfg: TypingConfig = DEFAULT_TYPING_CONFIG
): TypingTransition {
  if (state.phase === "destroyed") {
    return { next: state, effect: { kind: "noop" } }
  }

  switch (event.type) {
    case "destroy": {
      // If we ever sent a start, send a final stop on destroy.
      const needsStop = state.phase === "active" || state.phase === "starting"
      return {
        next: { ...state, phase: "destroyed" },
        effect: needsStop ? { kind: "send", op: "stop" } : { kind: "noop" },
      }
    }

    case "request_start": {
      // Idempotent: ignore if already starting/active
      if (state.phase === "starting" || state.phase === "active") {
        return { next: state, effect: { kind: "noop" } }
      }
      return {
        next: {
          ...state,
          phase: "starting",
          startedAt: event.at,
          lastHeartbeatAt: event.at,
          consecutiveFailures: 0,
        },
        effect: { kind: "send", op: "start" },
      }
    }

    case "request_stop": {
      if (state.phase === "idle" || state.phase === "stopping") {
        return { next: state, effect: { kind: "noop" } }
      }
      return {
        next: { ...state, phase: "stopping" },
        effect: { kind: "send", op: "stop" },
      }
    }

    case "send_ok": {
      if (state.phase === "starting") {
        return {
          next: {
            ...state,
            phase: "active",
            consecutiveFailures: 0,
            lastHeartbeatAt: event.at,
          },
          effect: { kind: "schedule_heartbeat", afterMs: cfg.heartbeatMs },
        }
      }
      if (state.phase === "active") {
        // Heartbeat succeeded
        return {
          next: { ...state, lastHeartbeatAt: event.at, consecutiveFailures: 0 },
          effect: { kind: "schedule_heartbeat", afterMs: cfg.heartbeatMs },
        }
      }
      if (state.phase === "stopping") {
        // Stop confirmed
        return {
          next: {
            ...state,
            phase: "idle",
            startedAt: null,
            lastHeartbeatAt: null,
          },
          effect: { kind: "noop" },
        }
      }
      return { next: state, effect: { kind: "noop" } }
    }

    case "send_failed": {
      const failures = state.consecutiveFailures + 1
      if (failures >= cfg.maxFailures) {
        // Give up: pretend stopped, do not retry
        return {
          next: {
            ...state,
            phase: "idle",
            startedAt: null,
            lastHeartbeatAt: null,
            consecutiveFailures: failures,
          },
          effect: { kind: "noop" },
        }
      }
      if (state.phase === "starting" || state.phase === "active") {
        // Retry the heartbeat sooner
        return {
          next: { ...state, consecutiveFailures: failures },
          effect: { kind: "schedule_heartbeat", afterMs: cfg.heartbeatMs },
        }
      }
      return {
        next: { ...state, consecutiveFailures: failures },
        effect: { kind: "noop" },
      }
    }

    case "heartbeat_tick": {
      if (state.phase !== "active") {
        return { next: state, effect: { kind: "noop" } }
      }
      // TTL check first: if startedAt + ttl < now, force stop
      if (state.startedAt !== null && event.at - state.startedAt >= cfg.ttlMs) {
        return {
          next: { ...state, phase: "stopping" },
          effect: { kind: "send", op: "stop" },
        }
      }
      // Send another start to refresh the typing indicator
      return {
        next: { ...state, lastHeartbeatAt: event.at },
        effect: { kind: "send", op: "start" },
      }
    }

    case "ttl_check": {
      if (state.phase !== "active" || state.startedAt === null) {
        return { next: state, effect: { kind: "noop" } }
      }
      if (event.at - state.startedAt >= cfg.ttlMs) {
        return {
          next: { ...state, phase: "stopping" },
          effect: { kind: "send", op: "stop" },
        }
      }
      return { next: state, effect: { kind: "noop" } }
    }
  }
}
