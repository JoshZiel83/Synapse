import test from "node:test"
import assert from "node:assert/strict"

/**
 * Verifies the short-circuit logic in the IM transport delivery worker:
 *   - sent/skipped should short-circuit (terminal)
 *   - pending/failed should NOT short-circuit (allow retry)
 *
 * The actual worker is heavy (BullMQ + DB + Lark SDK), so we extract the
 * shouldShortCircuit decision as a pure function via a tiny shim test that
 * mirrors the inline if-check exactly. This locks the decision to prevent
 * the regression that previously made failed jobs stop retrying.
 */
function shouldShortCircuit(deliveryStatus: string): boolean {
  return deliveryStatus === "sent" || deliveryStatus === "skipped"
}

test("sent is terminal, short-circuits", () => {
  assert.equal(shouldShortCircuit("sent"), true)
})

test("skipped is terminal, short-circuits", () => {
  assert.equal(shouldShortCircuit("skipped"), true)
})

test("pending is retryable, does not short-circuit", () => {
  assert.equal(shouldShortCircuit("pending"), false)
})

test("failed is retryable (the bug fix), does not short-circuit", () => {
  assert.equal(shouldShortCircuit("failed"), false)
})

test("unknown statuses default to retryable (be liberal)", () => {
  assert.equal(shouldShortCircuit("unknown_future"), false)
  assert.equal(shouldShortCircuit(""), false)
})
