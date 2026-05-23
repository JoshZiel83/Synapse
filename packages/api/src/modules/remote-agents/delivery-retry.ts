export const DELIVERY_RETRY_BACKOFF_BASE_MS = 5_000
export const DELIVERY_RETRY_BACKOFF_CAP_MS = 5 * 60_000
export const DELIVERY_MAX_ATTEMPTS = 8

export function nextAttemptDelayMs(attempts: number) {
  if (attempts <= 0) return 0
  const exponent = Math.min(attempts - 1, 30)
  const raw = DELIVERY_RETRY_BACKOFF_BASE_MS * 2 ** exponent
  return Math.min(raw, DELIVERY_RETRY_BACKOFF_CAP_MS)
}

export function shouldFailDelivery(attempts: number) {
  return attempts >= DELIVERY_MAX_ATTEMPTS
}

export function nextAttemptAt(now: Date, attempts: number) {
  return new Date(now.getTime() + nextAttemptDelayMs(attempts))
}
