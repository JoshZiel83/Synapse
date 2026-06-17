import test from "node:test"
import assert from "node:assert/strict"
import { QQ_DUPLICATE_MSG_SEQ_CODES } from "./outbound.js"

// These tests lock in the safety property that ONLY sandbox-verified or
// officially-documented duplicate-msg_seq codes may live in the
// ambiguous-success allow-list. The codes listed below have been
// considered in the past and rejected because their meaning is either
// unverified or known-wrong; adding any of them back without a unit
// test + a sandbox-capture reference triggers a CI failure here.

test("QQ_DUPLICATE_MSG_SEQ_CODES is empty by default in v1", () => {
  // v1 deliberately ships with no codes — every duplicate-shaped response
  // falls through to the generic permanent-failure branch so the
  // operator sees the real business code instead of a silent
  // "delivered" claim. See the constant's doc comment for the
  // population rule before adding entries.
  assert.equal(QQ_DUPLICATE_MSG_SEQ_CODES.size, 0)
})

// One assertion per code we've previously considered. If someone later
// adds the code WITHOUT moving the assertion (and without authoritative
// backing — see the doc comment), CI fails here, prompting either:
//   - confirm with a sandbox repro + delete the corresponding assertion
//   - revert the addition
test("304022 (unverified) is NOT in the duplicate allow-list", () => {
  assert.equal(
    QQ_DUPLICATE_MSG_SEQ_CODES.has(304022),
    false,
    "304022 lacks an authoritative source for the duplicate-msg_seq " +
      "interpretation; add a sandbox-captured response + a unit test " +
      "before re-adding."
  )
})

test("304023 is NOT in the duplicate allow-list (it's PUSH_MSG_ASYNC_OK, not a duplicate)", () => {
  // Per the official wiki, 304023 = PUSH_MSG_ASYNC_OK and 304024 =
  // REPLY_MSG_ASYNC_OK ("accepted, awaiting manual audit") — async success
  // signals, NOT duplicate msg_seq (the earlier "推荐子频道超限" reading
  // copied from openclaw was wrong). They must be handled via the
  // audit-pending path, never the duplicate-success path. See audit H5.
  assert.equal(QQ_DUPLICATE_MSG_SEQ_CODES.has(304023), false)
})

test("40034015 (unverified) is NOT in the duplicate allow-list", () => {
  assert.equal(
    QQ_DUPLICATE_MSG_SEQ_CODES.has(40034015),
    false,
    "40034015 was previously listed but with no authoritative citation " +
      "found in the openclaw clone or QQ wiki. Reproduce in sandbox " +
      "and add a unit test before re-adding."
  )
})
