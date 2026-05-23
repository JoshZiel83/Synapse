/**
 * Test utilities: a deterministic Clock that lets tests advance time and
 * fires scheduled callbacks synchronously when due.
 */

import type { Clock, TimerHandle } from "../modules/im/status-reaction/clock.js"

interface FakeTimer {
  id: number
  fireAt: number
  callback: () => void
  cancelled: boolean
}

export interface FakeClock extends Clock {
  /** Move time forward by `ms`, firing callbacks in fire-time order. */
  advance(ms: number): void
  /** Move to an absolute time. */
  advanceTo(t: number): void
  /** All currently scheduled (non-cancelled) timers, oldest first. */
  pending(): { id: number; fireAt: number }[]
  /** Number of timers fired since construction (for assertions). */
  firedCount(): number
}

export function createFakeClock(startAt = 0): FakeClock {
  let now = startAt
  let nextId = 1
  const timers: FakeTimer[] = []
  let fired = 0

  function fireDue(): void {
    while (true) {
      const due = timers
        .filter((t) => !t.cancelled && t.fireAt <= now)
        .sort((a, b) => a.fireAt - b.fireAt)
      if (due.length === 0) break
      const next = due[0]
      next.cancelled = true
      fired += 1
      next.callback()
    }
  }

  return {
    now: () => now,
    setTimeout(callback, ms) {
      const id = nextId++
      timers.push({ id, fireAt: now + ms, callback, cancelled: false })
      return { id }
    },
    clearTimeout(handle) {
      const t = timers.find((x) => x.id === handle.id)
      if (t) t.cancelled = true
    },
    advance(ms) {
      now += ms
      fireDue()
    },
    advanceTo(t) {
      if (t < now) throw new Error("cannot go back in time")
      now = t
      fireDue()
    },
    pending() {
      return timers
        .filter((t) => !t.cancelled)
        .map((t) => ({ id: t.id, fireAt: t.fireAt }))
    },
    firedCount() {
      return fired
    },
  }
}
