/**
 * StatusReactionController: drives a per-turn StatusReactionAdapter through
 * the pure state machine in `state.ts`, serializing adapter calls via a
 * Promise chain and using a Clock for timer-based debounce / stall checks.
 *
 * Lifecycle (one instance per turn):
 *   - createStatusReactionController({ adapter, clock, emojis, config? })
 *   - controller.set("queued") → ... → controller.set("coding")
 *   - controller.done() or controller.error() at turn end
 *   - controller.destroy() after terminal hold expires (auto-scheduled)
 *
 * Adapter is allowed to return null from the factory if the platform doesn't
 * support reactions; in that case the controller is a no-op object that
 * caller can still call without checks.
 */

import {
  DEFAULT_STATUS_EMOJIS,
  type StatusLevel,
} from "../messaging/status-emojis.js"
import type { Clock, TimerHandle } from "./clock.js"
import { RealClock } from "./clock.js"
import {
  DEFAULT_STATUS_CONFIG,
  INITIAL_STATUS_STATE,
  reduceStatus,
  type StatusConfig,
  type StatusEvent,
  type StatusEffect,
  type StatusState,
} from "./state.js"

export interface StatusReactionAdapter {
  /** Replace the currently-displayed reaction with `emoji`. */
  setReaction(emoji: string): Promise<void>
  /** Optional: remove the current reaction. Required for single-slot platforms. */
  clearReaction?(): Promise<void>
  /** Optional: remove a specific emoji (multi-slot platforms like Discord). */
  removeReaction?(emoji: string): Promise<void>
}

export interface StatusReactionController {
  set(level: StatusLevel): void
  done(): void
  error(): void
  destroy(): Promise<void>
  /** Current snapshot (for tests / debug). */
  inspect(): { state: StatusState; pendingTimers: number }
}

export interface CreateStatusControllerInput {
  adapter: StatusReactionAdapter | null
  clock?: Clock
  emojis?: Record<StatusLevel, string>
  config?: Partial<StatusConfig>
  /** Called on apply_failed; useful for tests / logging. */
  onError?: (err: unknown) => void
}

/**
 * Null adapter: returned when the platform connector has no reaction capability.
 * All methods are no-ops; callers don't need to null-check.
 */
const NULL_CONTROLLER: StatusReactionController = {
  set: () => {},
  done: () => {},
  error: () => {},
  destroy: async () => {},
  inspect: () => ({ state: INITIAL_STATUS_STATE, pendingTimers: 0 }),
}

export function createStatusReactionController(
  input: CreateStatusControllerInput
): StatusReactionController {
  if (!input.adapter) return NULL_CONTROLLER

  const clock = input.clock ?? RealClock
  const emojis = input.emojis ?? DEFAULT_STATUS_EMOJIS
  const config: StatusConfig = { ...DEFAULT_STATUS_CONFIG, ...input.config }
  const onError = input.onError ?? (() => {})

  let state: StatusState = INITIAL_STATUS_STATE
  const timers = new Set<TimerHandle>()
  let chain: Promise<void> = Promise.resolve()

  function dispatch(event: StatusEvent): void {
    const { next, effect } = reduceStatus(state, event, config)
    state = next
    applyEffect(effect)
  }

  function applyEffect(effect: StatusEffect): void {
    switch (effect.kind) {
      case "noop":
        return
      case "set_reaction": {
        const emoji = emojis[effect.level]
        chain = chain.then(
          async () => {
            try {
              await input.adapter!.setReaction(emoji)
              dispatch({ type: "apply_finished", at: clock.now() })
            } catch (err) {
              onError(err)
              dispatch({ type: "apply_failed", at: clock.now() })
            }
          },
          (err) => {
            // Should not happen: the inner function catches its own errors.
            onError(err)
          }
        )
        return
      }
      case "clear_reaction": {
        chain = chain.then(async () => {
          try {
            if (input.adapter!.clearReaction) {
              await input.adapter!.clearReaction()
            }
          } catch (err) {
            onError(err)
          }
        })
        return
      }
      case "schedule_tick": {
        const handle = clock.setTimeout(() => {
          timers.delete(handle)
          dispatch({ type: "tick", at: clock.now() })
        }, effect.afterMs)
        timers.add(handle)
        return
      }
    }
  }

  return {
    set(level) {
      dispatch({ type: "request_set", level, at: clock.now() })
    },
    done() {
      dispatch({ type: "request_set", level: "done", at: clock.now() })
    },
    error() {
      dispatch({ type: "request_set", level: "error", at: clock.now() })
    },
    async destroy() {
      dispatch({ type: "destroy", at: clock.now() })
      for (const handle of timers) {
        clock.clearTimeout(handle)
      }
      timers.clear()
      await chain
    },
    inspect() {
      return { state, pendingTimers: timers.size }
    },
  }
}
