import assert from "node:assert/strict"
import { test } from "node:test"
import {
  activeWireTraceFields,
  getCarrier,
  getTraceparent,
  isValidTraceparent,
  runWithCarrier,
  traceIdOf,
} from "./trace-context.js"

const TP = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"

test("activeWireTraceFields: machine-message frames inside a carrier scope carry the pair; outside they carry NOTHING", () => {
  // Outside any scope (the heartbeat situation): spreading the fields adds
  // no keys — a heartbeat-style frame stays untraced by construction.
  const bare = {
    type: "agent:status",
    state: "running",
    ...activeWireTraceFields(),
  }
  assert.equal("traceparent" in bare, false)
  assert.equal("tracestate" in bare, false)

  // Inside a scope WITH tracestate: both fields ride the frame.
  runWithCarrier({ traceparent: TP, tracestate: "es=s:1.0" }, () => {
    const frame = {
      type: "agent:status",
      state: "running",
      ...activeWireTraceFields(),
    }
    assert.equal(frame.traceparent, TP)
    assert.equal(frame.tracestate, "es=s:1.0")
  })

  // Inside a scope WITHOUT tracestate: traceparent only, never an empty
  // tracestate key.
  runWithCarrier({ traceparent: TP }, () => {
    const fields = activeWireTraceFields()
    assert.deepEqual(fields, { traceparent: TP })
    assert.equal("tracestate" in fields, false)
  })
})

test("runWithCarrier: undefined scope is a plain call-through; scopes nest and restore", () => {
  assert.equal(
    runWithCarrier(undefined, () => getCarrier()),
    undefined
  )
  runWithCarrier({ traceparent: TP }, () => {
    assert.equal(getTraceparent(), TP)
    const inner = "00-1af7651916cd43dd8448eb211c80319d-c7ad6b7169203332-01"
    runWithCarrier({ traceparent: inner }, () => {
      assert.equal(getTraceparent(), inner)
    })
    assert.equal(getTraceparent(), TP, "outer scope restored")
  })
  assert.equal(getTraceparent(), undefined, "no leak outside the scope")
})

test("traceIdOf / isValidTraceparent follow the pinned §3c contract", () => {
  assert.equal(traceIdOf(TP), "0af7651916cd43dd8448eb211c80319c")
  assert.equal(traceIdOf("garbage"), undefined)
  assert.equal(
    traceIdOf("00-00000000000000000000000000000000-b7ad6b7169203331-01"),
    undefined,
    "all-zero trace-id is rejected"
  )
  assert.equal(isValidTraceparent(TP), true)
  assert.equal(isValidTraceparent(TP.toUpperCase()), false)
  assert.equal(isValidTraceparent(null), false)
})
