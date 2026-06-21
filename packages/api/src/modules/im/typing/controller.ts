/**
 * TypingController: drives a TypingAdapter through the pure state machine.
 *
 * One instance per turn. The adapter exposes simple start/stop; the controller
 * handles heartbeat refresh, TTL bound, and failure guard so the caller never
 * needs to remember to "stop" — destroy() will do it if still active.
 */

import type { Clock, TimerHandle } from "../status-reaction/clock.js"
import { RealClock } from "../status-reaction/clock.js"
import {
  DEFAULT_TYPING_CONFIG,
  INITIAL_TYPING_STATE,
  reduceTyping,
  type TypingConfig,
  type TypingEffect,
  type TypingEvent,
  type TypingState,
} from "./state.js"

export interface TypingAdapter {
  start(): Promise<void>
  stop(): Promise<void>
}

export interface TypingController {
  start(): void
  stop(): void
  destroy(): Promise<void>
  inspect(): { state: TypingState; pendingTimers: number }
}

export interface CreateTypingControllerInput {
  adapter: TypingAdapter | null
  clock?: Clock
  config?: Partial<TypingConfig>
  onError?: (err: unknown) => void
}

const NULL_CONTROLLER: TypingController = {
  start: () => {},
  stop: () => {},
  destroy: async () => {},
  inspect: () => ({ state: INITIAL_TYPING_STATE, pendingTimers: 0 }),
}

export function createTypingController(
  input: CreateTypingControllerInput
): TypingController {
  if (!input.adapter) return NULL_CONTROLLER

  const clock = input.clock ?? RealClock
  const config: TypingConfig = { ...DEFAULT_TYPING_CONFIG, ...input.config }
  const onError = input.onError ?? (() => {})

  let state: TypingState = INITIAL_TYPING_STATE
  const timers = new Set<TimerHandle>()
  let chain: Promise<void> = Promise.resolve()

  function dispatch(event: TypingEvent): void {
    const { next, effect } = reduceTyping(state, event, config)
    state = next
    applyEffect(effect)
  }

  function applyEffect(effect: TypingEffect): void {
    switch (effect.kind) {
      case "noop":
        return
      case "send": {
        const op = effect.op
        chain = chain.then(async () => {
          try {
            if (op === "start") await input.adapter!.start()
            else await input.adapter!.stop()
            dispatch({ type: "send_ok", at: clock.now() })
          } catch (err) {
            onError(err)
            dispatch({ type: "send_failed", at: clock.now() })
          }
        })
        return
      }
      case "schedule_heartbeat":
      case "schedule_ttl": {
        const handle = clock.setTimeout(() => {
          timers.delete(handle)
          dispatch(
            effect.kind === "schedule_heartbeat"
              ? { type: "heartbeat_tick", at: clock.now() }
              : { type: "ttl_check", at: clock.now() }
          )
        }, effect.afterMs)
        timers.add(handle)
      }
    }
  }

  return {
    start() {
      dispatch({ type: "request_start", at: clock.now() })
    },
    stop() {
      dispatch({ type: "request_stop", at: clock.now() })
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
