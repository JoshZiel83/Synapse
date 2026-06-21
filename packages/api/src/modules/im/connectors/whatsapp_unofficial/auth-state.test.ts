import test from "node:test"
import assert from "node:assert/strict"
import { buildManagedAuthState } from "./auth-state.js"
import { freshAuthSnapshot } from "./creds-persistence.js"

test("key store set/get round-trips a pre-key", async () => {
  const managed = buildManagedAuthState(freshAuthSnapshot())
  const value = { public: Buffer.from([1, 2]), private: Buffer.from([3, 4]) }
  managed.state.keys.set({ "pre-key": { "1": value } })
  const got = await managed.state.keys.get("pre-key", ["1", "2"])
  assert.deepEqual(got["1"], value)
  assert.equal(got["2"], undefined)
})

test("set with null deletes a key", async () => {
  const managed = buildManagedAuthState(freshAuthSnapshot())
  managed.state.keys.set({ session: { a: new Uint8Array([9]) } })
  assert.ok((await managed.state.keys.get("session", ["a"])).a)
  managed.state.keys.set({ session: { a: null } })
  assert.equal((await managed.state.keys.get("session", ["a"])).a, undefined)
})

test("onKeysChanged fires on every mutating set (drives persistence)", () => {
  const managed = buildManagedAuthState(freshAuthSnapshot())
  let count = 0
  managed.onKeysChanged(() => {
    count += 1
  })
  managed.state.keys.set({
    "pre-key": { "1": { public: Buffer.from([1]), private: Buffer.from([2]) } },
  })
  managed.state.keys.set({ session: { x: new Uint8Array([1]) } })
  assert.equal(count, 2)
})

test("getSnapshot reflects key mutations + holds creds by reference", () => {
  const snap = freshAuthSnapshot()
  const managed = buildManagedAuthState(snap)
  managed.state.keys.set({ session: { s1: new Uint8Array([7]) } })
  const out = managed.getSnapshot()
  assert.ok(out.keys.session?.s1)
  // creds is the same object Baileys mutates in place.
  assert.equal(out.creds, snap.creds)
})
