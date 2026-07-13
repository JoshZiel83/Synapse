// P8(B) — fail-closed persisted-row adapter resolution. adapterForRow must THROW
// on an unknown persisted adapter key instead of silently downgrading it to a
// local resident adapter (which would run teardown/liveness/reconnect on the
// WRONG substrate). The four registered keys still resolve. No DB needed.

import test from "node:test"
import assert from "node:assert/strict"
import { adapterForRow, listRegisteredAdapterKeys } from "./adapter-registry.js"
import { SANDBOX_ADAPTER_KEYS } from "./adapter-keys.js"

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

// P1.2 INVARIANT: every registered BARE adapter must be HOST-SIDE
// (capabilities.confinedFs==='native'). The bare data plane is rebuilt on the
// host (host-dir materialize/commit-scan + a host-side inprocess:/docker-exec:
// endpoint fork). An OFF-BOX adapter (e2b/cube, confinedFs:'unsupported') would
// silently misuse that host path — so the FIRST such adapter must trip THIS guard
// and force the adapter.rebuildDataPlane + off-box working-set seam to be built +
// validated with it (P4b). Resident adapters carry a null descriptor (device-
// runtime owns its own confinement), so they are exempt.
test("P1.2: no registry key-drift; every registered bare adapter is host-side (confinedFs='native')", () => {
  // Drive off the REAL registry, not a hardcoded list — so registering ANY new
  // adapter is FORCED through the guard below. (a) the config/boot key leaf and
  // the factory map must agree (a key added to only one side would escape the
  // per-adapter assertion or the boot validation); (b) every bare adapter is
  // host-side. A future off-box e2b:bare (confinedFs:'unsupported') added to the
  // registry then FAILS this test until adapter.rebuildDataPlane + the off-box
  // working-set seam land (the P1.2/P4b forcing function).
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
      // A registered bare adapter is EITHER host-side (confinedFs='native', plane
      // rebuilt via the scheme-forked rebuildBarePlane) OR off-box
      // (confinedFs='unsupported'), in which case it MUST supply the P4b
      // adapter.rebuildDataPlane seam (LEXICAL confinement; the VM is the jail).
      // Anything else — an off-box descriptor WITHOUT rebuildDataPlane — trips this
      // guard and stays unregisterable (the P1.2/P4b forcing function).
      const cf = a.capabilities?.confinedFs
      assert.ok(
        cf === "native" ||
          (cf === "unsupported" && typeof a.rebuildDataPlane === "function"),
        `${key} must be host-side (confinedFs='native') OR an off-box adapter that ` +
          `implements adapter.rebuildDataPlane (confinedFs='unsupported') — got ` +
          `confinedFs='${cf}', rebuildDataPlane=${typeof a.rebuildDataPlane}`
      )
    } else {
      assert.equal(
        a.capabilities,
        null,
        `${key} resident carries no frozen descriptor (device-runtime confines)`
      )
    }
  }
})
