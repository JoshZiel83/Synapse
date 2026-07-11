// P8(B) — fail-closed persisted-row adapter resolution. adapterForRow must THROW
// on an unknown persisted adapter key instead of silently downgrading it to a
// local resident adapter (which would run teardown/liveness/reconnect on the
// WRONG substrate). The four registered keys still resolve. No DB needed.

import test from "node:test"
import assert from "node:assert/strict"
import { adapterForRow } from "./adapter-registry.js"

test("P8(B): adapterForRow throws (fail-closed) on an unknown persisted adapter key", () => {
  // e2b / cube are residual and NOT registered in P4a — a persisted row carrying
  // one must fail-closed, never downgrade to local resident.
  assert.throws(
    () => adapterForRow("e2b", "bare"),
    /unknown persisted adapter key 'e2b:bare'/
  )
  assert.throws(
    () => adapterForRow("cube", "resident"),
    /unknown persisted adapter key 'cube:resident'/
  )
  // A wholly bogus provider likewise fails closed rather than silently becoming
  // a local resident adapter (the old "legacy row" downgrade).
  assert.throws(() => adapterForRow("totally-bogus", "resident"), /fail-closed/)
})

test("P8(B): adapterForRow still resolves each of the four registered keys", () => {
  for (const [adapter, mode] of [
    ["local", "resident"],
    ["docker", "resident"],
    ["local", "bare"],
    ["docker", "bare"],
  ] as const) {
    const a = adapterForRow(adapter, mode)
    assert.equal(a.provider, adapter, `${adapter}:${mode} → provider`)
    assert.equal(a.mode, mode, `${adapter}:${mode} → mode`)
  }
})
