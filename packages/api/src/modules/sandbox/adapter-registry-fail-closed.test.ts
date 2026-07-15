// P8(B) — fail-closed persisted-row adapter resolution + the registration CONSTRUCT
// smoke. The 3-way registration invariant (metadata leaf ⇄ factory key ⇄ returned kind)
// is now a COMPILE-TIME closure (R9): ADAPTER_FACTORIES is typed
// `{ [K in SandboxAdapterKey]: (deps?) => AdapterForKey<K> }`, so a missing/extra factory
// key OR a factory returning the wrong-kind variant is a `tsc` error — there is nothing
// left to runtime-assert about the key set, the kinds, or the per-variant method sets
// (the discriminated union guarantees them). What the TYPE SYSTEM cannot run is checked
// here: (1) adapterForRow fail-closes (THROWS) on an unknown PERSISTED key rather than
// downgrading to the wrong substrate, and (2) every registered factory actually
// CONSTRUCTS without throwing and stamps the one leaf VALUE the type can't pin,
// meta.tag == provider. No DB needed.

import test from "node:test"
import assert from "node:assert/strict"
import { adapterForRow } from "./adapter-registry.js"

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

test("P8(B): every registered key constructs (smoke) + stamps meta.tag == provider", () => {
  // The compile-time closure proves the key set, the kinds, and the per-variant method
  // sets; this only smokes that each factory RUNS without throwing and pins the one leaf
  // VALUE the type system can't: meta.tag == provider (the persisted adapter tag).
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
    assert.equal(
      a.meta.tag,
      adapter,
      `${adapter}:${mode} → meta.tag == provider`
    )
  }
})
