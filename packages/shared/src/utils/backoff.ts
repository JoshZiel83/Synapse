/**
 * Capped exponential backoff with jitter — the single source of truth for the
 * "reconnect / retry after N failures" delay used by WS supervisors, IM
 * gateway reconnect loops, and delivery retry schedules.
 *
 * Pure math (no timers, no node: imports) so it is safe for every consumer
 * (api, device-runtime, web). Pass the attempt number (the count of failures
 * so far) and get back a millisecond delay.
 *
 *   delay = clamp(baseMs * 2 ** min(attempt, maxExponent), minMs, maxMs)
 *           then apply jitter
 *
 * Jitter modes:
 *   - "symmetric" (default): delay * (1 ± jitter)  — spreads around the value
 *   - "additive":            delay + random(0..jitterMs) — only ever adds
 *
 * `random` is injectable so tests are deterministic.
 */
export interface ComputeBackoffOptions {
  /** Delay for attempt 0, before exponential growth. */
  readonly baseMs: number
  /** Hard ceiling on the (pre-jitter) delay. */
  readonly maxMs: number
  /** Floor on the final delay. Defaults to baseMs. */
  readonly minMs?: number
  /**
   * Cap on the exponent so 2 ** attempt cannot overflow on a stuck loop.
   * Defaults to 30. (The maxMs clamp already bounds the value; this just keeps
   * the intermediate multiplication sane.)
   */
  readonly maxExponent?: number
  /** Jitter strategy. Default "symmetric". */
  readonly jitterMode?: "symmetric" | "additive"
  /**
   * For "symmetric": fraction of the delay to jitter by (e.g. 0.25 = ±25%).
   * For "additive": this is ignored; use jitterMs instead.
   * Default 0.
   */
  readonly jitter?: number
  /** For "additive": max milliseconds to add. Default 0. */
  readonly jitterMs?: number
  /** Injectable RNG in [0, 1). Defaults to Math.random. */
  readonly random?: () => number
}

export function computeBackoff(
  attempt: number,
  options: ComputeBackoffOptions
): number {
  const {
    baseMs,
    maxMs,
    minMs = baseMs,
    maxExponent = 30,
    jitterMode = "symmetric",
    jitter = 0,
    jitterMs = 0,
    random = Math.random,
  } = options

  const safeAttempt = Math.max(0, Math.floor(attempt))
  const exponent = Math.min(safeAttempt, maxExponent)
  const raw = Math.min(maxMs, baseMs * 2 ** exponent)

  if (jitterMode === "additive") {
    return Math.max(minMs, Math.floor(raw + random() * jitterMs))
  }
  // symmetric: raw * (1 ± jitter)
  const delta = raw * jitter * (random() * 2 - 1)
  return Math.max(minMs, Math.floor(raw + delta))
}
