import test from "node:test"
import assert from "node:assert/strict"
import type { TransportAccountSummary } from "@synapse/shared/types"
import { buildCanonicalMessage } from "../../messaging/canonical-message.js"
import {
  PermanentTransportError,
  RetryableTransportError,
  type OutboundEndpointRef,
} from "../types.js"
import { sendWhatsappMessage } from "./outbound.js"

function account(): TransportAccountSummary {
  return {
    id: "acc1",
    workspaceId: "ws1",
    transportKind: "whatsapp_unofficial",
    accountKey: "15551234567",
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

const endpoint: OutboundEndpointRef = {
  endpointType: "direct",
  externalId: "15559998888@s.whatsapp.net",
  metadata: {},
}

function fakeSocket(captured: { jid?: string; content?: unknown }) {
  return {
    sendMessage: async (jid: string, content: unknown) => {
      captured.jid = jid
      captured.content = content
      return { key: { id: "WAID-1" } }
    },
  } as never
}

test("paused account → RetryableTransportError", async () => {
  await assert.rejects(
    sendWhatsappMessage(
      {
        account: account(),
        endpoint,
        message: buildCanonicalMessage([{ type: "text", text: "x" }]),
      },
      { paused: async () => true, resolveSocket: () => fakeSocket({}) }
    ),
    RetryableTransportError
  )
})

test("no live socket → RetryableTransportError", async () => {
  await assert.rejects(
    sendWhatsappMessage(
      {
        account: account(),
        endpoint,
        message: buildCanonicalMessage([{ type: "text", text: "x" }]),
      },
      { paused: async () => false, resolveSocket: () => null }
    ),
    RetryableTransportError
  )
})

test("sends text and returns externalMessageId from sent.key.id", async () => {
  const captured: { jid?: string; content?: unknown } = {}
  const result = await sendWhatsappMessage(
    {
      account: account(),
      endpoint,
      message: buildCanonicalMessage([{ type: "text", text: "hello" }]),
    },
    {
      paused: async () => false,
      resolveSocket: () => fakeSocket(captured),
      readContent: async () => Buffer.from(""),
      transcodeVoice: async (b) => b,
    }
  )
  assert.equal(result.externalMessageId, "WAID-1")
  assert.equal(captured.jid, "15559998888@s.whatsapp.net")
  assert.deepEqual(captured.content, { text: "hello" })
})

test("empty message after degradation → PermanentTransportError", async () => {
  await assert.rejects(
    sendWhatsappMessage(
      {
        account: account(),
        endpoint,
        message: buildCanonicalMessage([{ type: "text", text: "   " }]),
      },
      { paused: async () => false, resolveSocket: () => fakeSocket({}) }
    ),
    PermanentTransportError
  )
})

test("reaction part is sent as a react message", async () => {
  const captured: { jid?: string; content?: unknown } = {}
  const result = await sendWhatsappMessage(
    {
      account: account(),
      endpoint,
      message: buildCanonicalMessage([
        {
          type: "reaction",
          emoji: "👍",
          target: { externalMessageId: "TARGET-1" },
        },
      ]),
    },
    {
      paused: async () => false,
      resolveSocket: () => fakeSocket(captured),
    }
  )
  assert.equal(result.externalMessageId, "WAID-1")
  const c = captured.content as {
    react?: { text: string; key: { id: string } }
  }
  assert.equal(c.react?.text, "👍")
  assert.equal(c.react?.key.id, "TARGET-1")
})

test("socket send failure → RetryableTransportError (transient)", async () => {
  const throwingSocket = {
    sendMessage: async () => {
      throw new Error("socket closed")
    },
  } as never
  await assert.rejects(
    sendWhatsappMessage(
      {
        account: account(),
        endpoint,
        message: buildCanonicalMessage([{ type: "text", text: "hi" }]),
      },
      { paused: async () => false, resolveSocket: () => throwingSocket }
    ),
    RetryableTransportError
  )
})

test("send returning no id → RetryableTransportError", async () => {
  const noIdSocket = {
    sendMessage: async () => ({ key: {} }),
  } as never
  await assert.rejects(
    sendWhatsappMessage(
      {
        account: account(),
        endpoint,
        message: buildCanonicalMessage([{ type: "text", text: "hi" }]),
      },
      { paused: async () => false, resolveSocket: () => noIdSocket }
    ),
    RetryableTransportError
  )
})
