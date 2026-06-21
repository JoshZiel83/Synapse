import test from "node:test"
import assert from "node:assert/strict"
import {
  clearOffset,
  getOffset,
  offsetKey,
  setOffset,
  type CursorRedis,
} from "./cursor-store.js"

class FakeRedis implements CursorRedis {
  store = new Map<string, string>()
  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null
  }
  async set(key: string, value: string): Promise<"OK"> {
    this.store.set(key, value)
    return "OK"
  }
  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0
  }
}

test("offsetKey: per-account namespacing", () => {
  assert.equal(offsetKey("a1"), "im:telegram:offset:a1")
})

test("getOffset: 0 when unset, parses stored value", async () => {
  const r = new FakeRedis()
  assert.equal(await getOffset("acc", r), 0)
  await setOffset("acc", 42, r)
  assert.equal(await getOffset("acc", r), 42)
})

test("setOffset: no-op for non-positive", async () => {
  const r = new FakeRedis()
  await setOffset("acc", 0, r)
  await setOffset("acc", -5, r)
  assert.equal(r.store.size, 0)
})

test("clearOffset: removes the key", async () => {
  const r = new FakeRedis()
  await setOffset("acc", 9, r)
  await clearOffset("acc", r)
  assert.equal(await getOffset("acc", r), 0)
})
