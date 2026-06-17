import test from "node:test"
import assert from "node:assert/strict"
import { assertIsoInstant } from "@synapse/shared/datetime"
import {
  getLatestInboundAnchor,
  writeLatestInboundAnchor,
  type QqLatestInboundAnchor,
} from "./latest-inbound-store.js"

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

function makeAnchor(
  overrides: Partial<QqLatestInboundAnchor> = {}
): QqLatestInboundAnchor {
  return {
    anchorKind: "msg_id",
    anchorId: "MSG-1",
    eventType: "C2C_MESSAGE_CREATE",
    receivedAt: assertIsoInstant("2026-06-16T01:00:00.000Z"),
    ...overrides,
  }
}

test("latest inbound anchor cache round-trips a valid internal Redis payload", async () => {
  const redis = new FakeRedis()
  const anchor = makeAnchor()
  await writeLatestInboundAnchor(redis as unknown as import("ioredis").Redis, {
    accountId: "acc-1",
    endpointType: "direct",
    endpointExternalId: "c2c:user-1",
    anchor,
  })

  const loaded = await getLatestInboundAnchor(
    redis as unknown as import("ioredis").Redis,
    {
      accountId: "acc-1",
      endpointType: "direct",
      endpointExternalId: "c2c:user-1",
    }
  )

  assert.deepEqual(loaded, anchor)
})

test("latest inbound anchor cache rejects malformed or drifted Redis payloads", async () => {
  const redis = new FakeRedis()
  const params = {
    accountId: "acc-1",
    endpointType: "group" as const,
    endpointExternalId: "group-1",
  }
  await writeLatestInboundAnchor(redis as unknown as import("ioredis").Redis, {
    ...params,
    anchor: makeAnchor({ anchorKind: "event_id" }),
  })

  redis.setLastRaw("{not-json")
  assert.equal(
    await getLatestInboundAnchor(
      redis as unknown as import("ioredis").Redis,
      params
    ),
    null
  )

  redis.setLastRaw(
    JSON.stringify({
      anchorKind: "message_id",
      anchorId: "MSG-1",
      eventType: "GROUP_AT_MESSAGE_CREATE",
      receivedAt: "not-an-instant",
    })
  )
  assert.equal(
    await getLatestInboundAnchor(
      redis as unknown as import("ioredis").Redis,
      params
    ),
    null
  )
})
