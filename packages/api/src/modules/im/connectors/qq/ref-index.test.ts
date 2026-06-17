import test from "node:test"
import assert from "node:assert/strict"
import { assertIsoInstant } from "@synapse/shared/datetime"
import {
  getRefIndexEntry,
  parseRefIndices,
  setRefIndexEntry,
  type QqRefIndexEntry,
} from "./ref-index.js"

class FakeRedis {
  private store = new Map<string, string>()
  lastSetKey: string | undefined

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null
  }

  async set(key: string, value: string): Promise<"OK"> {
    this.store.set(key, value)
    this.lastSetKey = key
    return "OK"
  }

  setLastRaw(value: string): void {
    assert.ok(this.lastSetKey)
    this.store.set(this.lastSetKey, value)
  }
}

function makeEntry(overrides: Partial<QqRefIndexEntry> = {}): QqRefIndexEntry {
  return {
    content: "quoted text",
    senderId: "c2c:user-1",
    senderName: "Alice",
    timestamp: assertIsoInstant("2026-06-16T01:00:00.000Z"),
    isBot: false,
    attachments: ["[图片] a.png"],
    ...overrides,
  }
}

test("parseRefIndices: extracts msg_idx + ref_msg_idx from array ext", () => {
  const result = parseRefIndices({
    ext: ["msg_idx=REF_A", "ref_msg_idx=REF_B", "other=ignored"],
  })
  assert.deepEqual(result, { msgIdx: "REF_A", refMsgIdx: "REF_B" })
})

test("parseRefIndices: tolerates a single string ext (not array)", () => {
  const result = parseRefIndices({ ext: "ref_msg_idx=REF_B" })
  assert.equal(result.refMsgIdx, "REF_B")
  assert.equal(result.msgIdx, undefined)
})

test("parseRefIndices: missing fields stay undefined", () => {
  assert.deepEqual(parseRefIndices({ ext: undefined }), {})
  assert.deepEqual(parseRefIndices({ ext: [] }), {})
  // No msg_idx/ref_msg_idx anywhere → both keys absent from result.
  const result = parseRefIndices({ ext: ["foo=bar"] })
  assert.equal(result.msgIdx, undefined)
  assert.equal(result.refMsgIdx, undefined)
})

test("parseRefIndices: ignores entries without '=' separator", () => {
  const result = parseRefIndices({ ext: ["malformed", "msg_idx="] })
  assert.equal(result.msgIdx, undefined)
  assert.equal(result.refMsgIdx, undefined)
})

test("parseRefIndices: first-occurrence wins on duplicates", () => {
  const result = parseRefIndices({
    ext: ["msg_idx=FIRST", "msg_idx=SECOND"],
  })
  assert.equal(result.msgIdx, "FIRST")
})

test("ref-index cache round-trips a valid internal Redis payload", async () => {
  const redis = new FakeRedis()
  const entry = makeEntry()
  await setRefIndexEntry(redis as unknown as import("ioredis").Redis, {
    accountId: "acc-1",
    refIdx: "REF-1",
    entry,
  })

  const loaded = await getRefIndexEntry(
    redis as unknown as import("ioredis").Redis,
    {
      accountId: "acc-1",
      refIdx: "REF-1",
    }
  )

  assert.deepEqual(loaded, entry)
})

test("ref-index cache rejects malformed or drifted Redis payloads", async () => {
  const redis = new FakeRedis()
  const params = { accountId: "acc-1", refIdx: "REF-1" }
  await setRefIndexEntry(redis as unknown as import("ioredis").Redis, {
    ...params,
    entry: makeEntry(),
  })

  redis.setLastRaw("{not-json")
  assert.equal(
    await getRefIndexEntry(redis as unknown as import("ioredis").Redis, params),
    null
  )

  redis.setLastRaw(
    JSON.stringify({
      content: "quoted text",
      senderId: "c2c:user-1",
      timestamp: "not-an-instant",
      attachments: ["ok", 123],
    })
  )
  assert.equal(
    await getRefIndexEntry(redis as unknown as import("ioredis").Redis, params),
    null
  )
})
