// P8(B) — fail-closed persisted-row adapter resolution. adapterForRow must THROW
// on an unknown persisted adapter key instead of silently downgrading it to a
// local resident adapter (which would run teardown/liveness/reconnect on the
// WRONG substrate). Every registered key still resolves. No DB needed.

import test from "node:test"
import assert from "node:assert/strict"
import {
  adapterForRow,
  listRegisteredAdapterKeys,
  isBareAdapter,
  isOffBoxAdapter,
} from "./adapter-registry.js"
import {
  SANDBOX_ADAPTER_KEYS,
  sandboxAdapterMetadata,
} from "./adapter-metadata.js"

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

test("P8(B): adapterForRow still resolves every registered key", () => {
  for (const [adapter, mode] of [
    ["local", "resident"],
    ["docker", "resident"],
    ["local", "bare"],
    ["docker", "bare"],
    ["cubesandbox", "bare"],
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

// R8 SINGLE-TRUTH-SOURCE INVARIANT: the adapter `kind` discriminant has exactly ONE
// authoritative home — the metadata leaf's `kind` field. Each factory HARDCODES the
// variant literal (resident | hostBare | offBoxBare); this test pins that literal
// against the leaf so the two can never silently drift (the old failure was `kind`
// being reconstructed from mode/offBox in two places). It also asserts the union is
// STRUCTURALLY sound: the discriminant matches the methods actually present, so the
// isBareAdapter / isOffBoxAdapter guards are provably total — a resident adapter can
// NOT carry off-box seams, and an off-box adapter always carries all of them.
test("R8: adapter.kind is single-sourced from the metadata leaf and structurally sound", () => {
  for (const key of SANDBOX_ADAPTER_KEYS) {
    const [provider, mode] = key.split(":") as [string, "resident" | "bare"]
    const entry = sandboxAdapterMetadata(provider, mode)
    assert.ok(entry, `${key} must have a metadata leaf`)
    const a = adapterForRow(provider, mode)

    // (1) factory literal === metadata leaf (the single truth source).
    assert.equal(
      a.kind,
      entry.kind,
      `${key}: factory kind '${a.kind}' must equal metadata-leaf kind '${entry.kind}'`
    )

    // (2) kind ↔ mode consistency.
    if (mode === "resident") {
      assert.equal(
        a.kind,
        "resident",
        `${key}: resident mode ⇒ kind 'resident'`
      )
    } else {
      assert.ok(
        a.kind === "hostBare" || a.kind === "offBoxBare",
        `${key}: bare mode ⇒ kind 'hostBare' | 'offBoxBare' (got '${a.kind}')`
      )
    }

    // (3) discriminant ↔ methods: the type guards must agree with the literal, and
    // the presence of the off-box-only seams must match the offBoxBare discriminant.
    assert.equal(
      isBareAdapter(a),
      a.kind !== "resident",
      `${key}: isBareAdapter must track (kind !== 'resident')`
    )
    assert.equal(
      isOffBoxAdapter(a),
      a.kind === "offBoxBare",
      `${key}: isOffBoxAdapter must track (kind === 'offBoxBare')`
    )
    if (isOffBoxAdapter(a)) {
      // An off-box adapter carries the full paid-resource lifecycle seam set.
      assert.equal(
        typeof a.listOrphans,
        "function",
        `${key}: off-box listOrphans`
      )
      assert.equal(
        typeof a.destroyResource,
        "function",
        `${key}: off-box destroyResource`
      )
      assert.equal(
        typeof a.refreshResourceDeadline,
        "function",
        `${key}: off-box refreshResourceDeadline`
      )
    }
  }
})
