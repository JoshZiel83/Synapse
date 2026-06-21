import test from "node:test"
import assert from "node:assert/strict"
import type { TransportAccountSummary } from "@synapse/shared/types"
import type { EndpointRef } from "../types.js"
import { TYPING_HEARTBEAT_MS } from "./types.js"
import { createWhatsappTypingAdapter } from "./typing.js"

function account(): TransportAccountSummary {
  return {
    id: "acc1",
    workspaceId: "ws1",
    transportKind: "whatsapp_unofficial",
    accountKey: "k",
    displayName: "WA",
    ownerScope: "workspace",
    inboundActorMode: "none",
    connectionMode: "long_connection",
    status: "active",
    config: {},
    metadata: {},
    createdAt: "2024-01-01T00:00:00.000Z" as never,
    updatedAt: "2024-01-01T00:00:00.000Z" as never,
  }
}

const endpointRef: EndpointRef = {
  endpointType: "direct",
  externalId: "15559998888@s.whatsapp.net",
  metadata: {},
}

test("sends composing on start and paused on stop, with heartbeat config", async () => {
  const calls: Array<{ presence: string; jid: string }> = []
  const socket = {
    sendPresenceUpdate: async (presence: string, jid: string) => {
      calls.push({ presence, jid })
    },
  } as never

  const { adapter, config } = createWhatsappTypingAdapter({
    account: account(),
    endpointRef,
    resolveSocket: () => socket,
  })

  assert.equal(config.heartbeatMs, TYPING_HEARTBEAT_MS)
  await adapter.start()
  await adapter.stop()
  assert.deepEqual(calls, [
    { presence: "composing", jid: "15559998888@s.whatsapp.net" },
    { presence: "paused", jid: "15559998888@s.whatsapp.net" },
  ])
})

test("no live socket → start/stop are silent no-ops", async () => {
  const { adapter } = createWhatsappTypingAdapter({
    account: account(),
    endpointRef,
    resolveSocket: () => null,
  })
  await adapter.start()
  await adapter.stop()
  // no throw == pass
})

test("socket errors are swallowed (typing is best-effort)", async () => {
  const socket = {
    sendPresenceUpdate: async () => {
      throw new Error("boom")
    },
  } as never
  const { adapter } = createWhatsappTypingAdapter({
    account: account(),
    endpointRef,
    resolveSocket: () => socket,
  })
  await adapter.start()
  // no throw == pass
})
