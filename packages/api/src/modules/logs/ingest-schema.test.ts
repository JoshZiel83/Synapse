// Log-ingest batch-poisoning backstop (plan §4.I change 5, adjudication
// 11/12): trace_id degrades at the FIELD level, malformed records are salvaged
// PER RECORD, and only a malformed batch ENVELOPE rejects outright.
import assert from "node:assert/strict"
import { test } from "node:test"
import { salvageLogBatch, MAX_RECORDS, RecordSchema } from "./ingest-schema.js"

const VALID_TRACE_ID = "0af7651916cd43dd8448eb211c80319c"

test("batch of 3 with one 200-char garbage trace_id ⇒ ALL THREE survive, the garbage one without a trace_id", () => {
  // The verify-C9c case: >64 chars fails RecordSchema's `.max(64)` — without
  // the `.catch(undefined)` that failure would reject the whole record (and,
  // pre-salvage, 400 the whole batch of up to 200).
  const batch = salvageLogBatch({
    records: [
      { msg: "a", trace_id: VALID_TRACE_ID },
      { msg: "b", trace_id: "x".repeat(200) },
      { msg: "c" },
    ],
  })
  assert.ok(batch)
  assert.equal(batch.rejected, 0)
  assert.equal(batch.records.length, 3)
  assert.equal(batch.records[0]?.trace_id, VALID_TRACE_ID)
  assert.equal(batch.records[1]?.msg, "b")
  assert.equal(batch.records[1]?.trace_id, undefined)
  assert.equal(batch.records[2]?.trace_id, undefined)
})

test("trace_id field-level degrade matrix: non-string / non-canonical / all-zero / uppercase ⇒ absent, record kept", () => {
  const cases: unknown[] = [
    12345, // wrong type — inner type failure caught
    "not-a-trace-id", // ≤64 but non-canonical — transform filter
    "0".repeat(32), // all-zero — canonical-rejection (?!0{32})
    VALID_TRACE_ID.toUpperCase(), // W3C ids are lowercase
    `00-${VALID_TRACE_ID}-b7ad6b7169203331-01`, // full traceparent, not a bare id
  ]
  for (const traceId of cases) {
    const parsed = RecordSchema.safeParse({ msg: "m", trace_id: traceId })
    assert.ok(parsed.success, `record must survive trace_id=${String(traceId)}`)
    assert.equal(parsed.data.trace_id, undefined)
  }
  // And the canonical value passes through verbatim.
  const ok = RecordSchema.safeParse({ msg: "m", trace_id: VALID_TRACE_ID })
  assert.ok(ok.success)
  assert.equal(ok.data.trace_id, VALID_TRACE_ID)
})

test("per-record salvage: a record malformed in a NON-trace field is rejected alone; the batch survives", () => {
  const batch = salvageLogBatch({
    records: [
      { msg: "good" },
      { msg: 12345 }, // non-string msg — record-level failure
      "not-an-object", // not even a record shape
      { msg: "also good", level: "warn" },
    ],
  })
  assert.ok(batch)
  assert.equal(batch.records.length, 2)
  assert.equal(batch.rejected, 2)
  assert.deepEqual(
    batch.records.map((r) => r.msg),
    ["good", "also good"]
  )
})

test("malformed batch ENVELOPE (not an object / records not an array / over MAX_RECORDS) ⇒ null (400)", () => {
  assert.equal(salvageLogBatch(undefined), null)
  assert.equal(salvageLogBatch("garbage"), null)
  assert.equal(salvageLogBatch({}), null)
  assert.equal(salvageLogBatch({ records: "nope" }), null)
  assert.equal(
    salvageLogBatch({
      records: Array.from({ length: MAX_RECORDS + 1 }, () => ({ msg: "x" })),
    }),
    null
  )
})

test("empty batch and all-rejected batch still salvage (202), never reject", () => {
  const empty = salvageLogBatch({ records: [] })
  assert.ok(empty)
  assert.equal(empty.records.length, 0)
  assert.equal(empty.rejected, 0)

  const allBad = salvageLogBatch({ records: [{ msg: 1 }, { msg: 2 }] })
  assert.ok(allBad)
  assert.equal(allBad.records.length, 0)
  assert.equal(allBad.rejected, 2)
})
