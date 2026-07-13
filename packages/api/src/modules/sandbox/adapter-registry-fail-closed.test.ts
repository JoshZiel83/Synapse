// P8(B) — fail-closed persisted-row adapter resolution. adapterForRow must THROW
// on an unknown persisted adapter key instead of silently downgrading it to a
// local resident adapter (which would run teardown/liveness/reconnect on the
// WRONG substrate). The four registered keys still resolve. No DB needed.

import test from "node:test"
import assert from "node:assert/strict"
import { adapterForRow, listRegisteredAdapterKeys } from "./adapter-registry.js"
import { SANDBOX_ADAPTER_KEYS } from "./adapter-metadata.js"

test("P8(B): adapterForRow throws (fail-closed) on an unknown persisted adapter key", () => {
  // e2b is residual and NOT registered (cubesandbox:bare IS, R4) — a persisted row
  // carrying an unknown tag must fail-closed, never downgrade to local resident.
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

// P1.2 INVARIANT (R4 §1.8 INVERTED): every registered BARE adapter MUST implement
// adapter.rebuildDataPlane AND declare an endpoint contract. The old guard forced
// every bare adapter to be HOST-SIDE (confinedFs==='native') because the spine
// owned a hardcoded inprocess:/docker-exec: scheme fork; R4 moved that fork INTO
// the adapters (each owns its rebuildDataPlane) and added the off-box seam, so the
// host-side restriction is GONE — an off-box adapter (confinedFs:'unsupported') is
// now first-class. What every bare adapter MUST still provide is the two seams the
// dispatch spine delegates to: rebuildDataPlane (rebuild-on-miss) + an endpoint
// contract (the R3.2 scheme + identity predicate).
test("P1.2: no registry key-drift; every registered bare adapter implements rebuildDataPlane + declares an endpoint contract", () => {
  // Drive off the REAL registry, not a hardcoded list — so registering ANY new
  // adapter is FORCED through the guard below. (a) the config/boot key leaf and
  // the factory map must agree (a key added to only one side would escape the
  // per-adapter assertion or the boot validation); (b) every bare adapter carries
  // the dispatch seams. A future bare adapter WITHOUT rebuildDataPlane/endpoint
  // then FAILS this test (the forcing function).
  assert.deepEqual(
    [...SANDBOX_ADAPTER_KEYS].sort(),
    listRegisteredAdapterKeys().sort(),
    "SANDBOX_ADAPTER_KEYS (config/boot) must exactly match ADAPTER_FACTORIES (registry)"
  )
  for (const key of SANDBOX_ADAPTER_KEYS) {
    const [provider, mode] = key.split(":") as [string, "resident" | "bare"]
    const a = adapterForRow(provider, mode)
    if (mode === "bare") {
      assert.ok(a.capabilities, `${key} must carry a capability descriptor`)
      // Every bare adapter owns its rebuild (host or off-box) + declares the
      // scheme/identity endpoint contract bare-dispatch resolves for R3.2.
      assert.equal(
        typeof a.rebuildDataPlane,
        "function",
        `${key} (bare) must implement adapter.rebuildDataPlane`
      )
      assert.ok(
        a.endpoint && typeof a.endpoint.identityOk === "function",
        `${key} (bare) must declare an endpoint contract (scheme + identityOk)`
      )
    } else {
      assert.equal(
        a.capabilities,
        null,
        `${key} resident carries no frozen descriptor (device-runtime confines)`
      )
      // Resident adapters have no bare data plane → no endpoint contract.
      assert.equal(a.endpoint, null, `${key} resident declares no endpoint`)
    }
  }
})
