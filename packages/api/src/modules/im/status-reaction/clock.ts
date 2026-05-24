/**
 * Clock abstraction for testability.
 *
 * Production code uses RealClock which wraps Date.now() and the global
 * setTimeout/clearTimeout. Tests inject FakeClock (in test-utils/) to advance
 * time deterministically.
 */

export interface TimerHandle {
  readonly id: number
}

export interface Clock {
  now(): number
  setTimeout(callback: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

export const RealClock: Clock = {
  now: () => Date.now(),
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms)
    // Node returns a Timer object; use its ref via a wrapper
    return { id: handle as unknown as number }
  },
  clearTimeout(handle) {
    clearTimeout(handle.id as unknown as NodeJS.Timeout)
  },
}
