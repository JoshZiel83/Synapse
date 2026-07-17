// Logger trace-correlation fixes (trace plan §4.G changes 6+12):
//   - the traceparent stamp is resolved PER RECORD from the ALS dispatch
//     carrier (the retired spawn-env convention stamped one process-lifetime
//     value on every line);
//   - a caller-supplied `traceparent` field can never clobber the stamp;
//   - the ship path derives trace_id ONLY via the canonical
//     traceIdFromTraceparent() — a non-matching value ships NO trace_id at
//     all (C9c batch-poisoning guard), never the raw string.
import assert from "node:assert/strict"
import test from "node:test"
import { configureDeviceLogShipping, createDeviceLogger } from "./logger.js"
import { runWithTraceContext } from "./trace-context.js"

const VALID_TP = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
const TRACE_ID = "0af7651916cd43dd8448eb211c80319c"

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const orig = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown): boolean => {
    lines.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  return {
    lines,
    restore: () => {
      process.stderr.write = orig
    },
  }
}

function parsed(lines: string[]): Array<Record<string, unknown>> {
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>)
}

test("per-record stamp: lines inside a dispatch carry ITS traceparent, lines outside carry none", () => {
  const log = createDeviceLogger("test")
  const cap = captureStderr()
  try {
    log.info("outside-before")
    runWithTraceContext({ traceparent: VALID_TP }, () =>
      log.info("inside-dispatch")
    )
    log.info("outside-after")
  } finally {
    cap.restore()
  }
  const [before, inside, after] = parsed(cap.lines)
  assert.equal(before!.traceparent, undefined)
  assert.equal(inside!.traceparent, VALID_TP)
  assert.equal(
    after!.traceparent,
    undefined,
    "the stamp must not outlive the dispatch (no process-lifetime constant)"
  )
})

test("clobber fix: caller-supplied data.traceparent is deleted, never echoed", () => {
  const log = createDeviceLogger("test")
  const cap = captureStderr()
  try {
    // no active dispatch → the hostile value must NOT appear at all
    log.info("no-context", { traceparent: "99-hostile-fake-00" })
    // active dispatch → the ALS value wins over the caller's
    runWithTraceContext({ traceparent: VALID_TP }, () =>
      log.info("with-context", { traceparent: "99-hostile-fake-00" })
    )
  } finally {
    cap.restore()
  }
  const [noCtx, withCtx] = parsed(cap.lines)
  assert.equal(noCtx!.traceparent, undefined)
  assert.equal(withCtx!.traceparent, VALID_TP)
  assert.equal(JSON.stringify(noCtx).includes("hostile"), false)
  assert.equal(JSON.stringify(withCtx).includes("hostile"), false)
})

test("ship-guard: valid traceparent ships its trace-id; a non-matching value ships NO trace_id", async () => {
  const bodies: Array<{ records: Array<Record<string, unknown>> }> = []
  const origFetch = globalThis.fetch
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response("{}", { status: 202 })
  }) as typeof fetch
  const cap = captureStderr() // silence the local sink
  try {
    configureDeviceLogShipping({
      endpoint: "http://api.internal/api/v1/logs",
      token: "test-token",
    })
    const log = createDeviceLogger("test")
    runWithTraceContext({ traceparent: VALID_TP }, () => log.info("valid-tp"))
    // runWithTraceContext performs NO validation (that's the _meta
    // extractor's job) — the ship guard must still refuse to derive a
    // trace_id from a non-matching value.
    runWithTraceContext({ traceparent: "garbage-not-a-traceparent" }, () =>
      log.info("garbage-tp")
    )
    // fill the buffer to SHIP_MAX so flush fires synchronously (no timer)
    for (let i = 0; i < 50; i += 1) log.info(`fill-${i}`)
  } finally {
    cap.restore()
    configureDeviceLogShipping(null)
    globalThis.fetch = origFetch
  }
  const records = bodies.flatMap((b) => b.records)
  const valid = records.find((r) => r.msg === "valid-tp")
  const garbage = records.find((r) => r.msg === "garbage-tp")
  assert.ok(valid, "valid-tp record must have shipped")
  assert.ok(garbage, "garbage-tp record must have shipped")
  assert.equal(valid.trace_id, TRACE_ID)
  assert.equal("trace_id" in garbage, false, "no trace_id key at all")
  assert.equal(JSON.stringify(garbage).includes("garbage-not-a"), false)
})
