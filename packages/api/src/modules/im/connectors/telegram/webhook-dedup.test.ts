import test from "node:test"
import assert from "node:assert/strict"
import {
  dedupKey,
  isDuplicateUpdate,
  type DedupRedis,
} from "./webhook-dedup.js"

class FakeNxRedis implements DedupRedis {
  store = new Set<string>()
  async set(key: string): Promise<"OK" | null> {
    if (this.store.has(key)) return null
    this.store.add(key)
    return "OK"
  }
}

test("dedupKey: account + update_id", () => {
  assert.equal(dedupKey("acc", 5), "im:telegram:dedup:acc:5")
})

test("isDuplicateUpdate: first false, repeat true", async () => {
  const r = new FakeNxRedis()
  assert.equal(await isDuplicateUpdate("acc", 1, r), false)
  assert.equal(await isDuplicateUpdate("acc", 1, r), true)
  // Different update_id is independent.
  assert.equal(await isDuplicateUpdate("acc", 2, r), false)
})

test("isDuplicateUpdate: fails open on redis error", async () => {
  const throwing: DedupRedis = {
    async set() {
      throw new Error("redis down")
    },
  }
  assert.equal(await isDuplicateUpdate("acc", 1, throwing), false)
})
