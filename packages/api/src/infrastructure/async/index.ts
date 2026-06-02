import { setTimeout as nodeSetTimeout } from "node:timers/promises"

/**
 * Abortable sleep. Resolves after `ms`, or early (also resolving) if `signal`
 * aborts — matching the dominant pattern in the IM connectors, where callers
 * sleep through a backoff then re-check their stop flag. Built on
 * node:timers/promises so the timer is unref'd-friendly and cleaned up on
 * abort automatically.
 *
 * Note: this RESOLVES on abort (it does not throw AbortError like the bare
 * node:timers/promises setTimeout does), so loop bodies don't need a
 * try/catch around every sleep.
 */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return
  try {
    await nodeSetTimeout(ms, undefined, { signal })
  } catch {
    // AbortError — treat as "woke up early", same as the old hand-rolled
    // resolve-on-abort helpers.
  }
}

/**
 * Run `promise` with a timeout. If it doesn't settle within `ms`, reject with
 * a timeout Error tagged with `label`. The timer is unref'd so it never keeps
 * the process alive.
 *
 * NOTE: like the helpers it replaces, this does NOT cancel the underlying work
 * — it only stops *waiting* for it. Wire an AbortSignal into the wrapped
 * operation if you need real cancellation.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = "operation"
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise

  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    )
    timer.unref?.()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
