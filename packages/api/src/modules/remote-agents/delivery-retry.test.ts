import test from "node:test"
import assert from "node:assert/strict"
import {
  DELIVERY_MAX_ATTEMPTS,
  DELIVERY_RETRY_BACKOFF_BASE_MS,
  DELIVERY_RETRY_BACKOFF_CAP_MS,
  nextAttemptAt,
  nextAttemptDelayMs,
  shouldFailDelivery,
} from "./delivery-retry.js"

test("nextAttemptDelayMs returns 0 before the first attempt", () => {
  assert.equal(nextAttemptDelayMs(0), 0)
})

test("nextAttemptDelayMs starts at the base delay on attempt 1", () => {
  assert.equal(nextAttemptDelayMs(1), DELIVERY_RETRY_BACKOFF_BASE_MS)
})

test("nextAttemptDelayMs doubles each attempt", () => {
  assert.equal(nextAttemptDelayMs(2), DELIVERY_RETRY_BACKOFF_BASE_MS * 2)
  assert.equal(nextAttemptDelayMs(3), DELIVERY_RETRY_BACKOFF_BASE_MS * 4)
  assert.equal(nextAttemptDelayMs(4), DELIVERY_RETRY_BACKOFF_BASE_MS * 8)
})

test("nextAttemptDelayMs caps at the configured maximum", () => {
  assert.equal(nextAttemptDelayMs(20), DELIVERY_RETRY_BACKOFF_CAP_MS)
  assert.equal(nextAttemptDelayMs(1000), DELIVERY_RETRY_BACKOFF_CAP_MS)
})

test("shouldFailDelivery becomes true at the max attempts threshold", () => {
  assert.equal(shouldFailDelivery(DELIVERY_MAX_ATTEMPTS - 1), false)
  assert.equal(shouldFailDelivery(DELIVERY_MAX_ATTEMPTS), true)
  assert.equal(shouldFailDelivery(DELIVERY_MAX_ATTEMPTS + 1), true)
})

test("nextAttemptAt offsets the current time by the backoff delay", () => {
  const now = new Date("2026-05-22T12:00:00Z")
  const scheduled = nextAttemptAt(now, 3)
  assert.equal(
    scheduled.getTime() - now.getTime(),
    DELIVERY_RETRY_BACKOFF_BASE_MS * 4
  )
})
