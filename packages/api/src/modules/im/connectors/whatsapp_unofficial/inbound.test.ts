import test from "node:test"
import assert from "node:assert/strict"
import type { ConnectorLogger, InboundEnvelope } from "../types.js"
import { processUpsertBatch } from "./inbound.js"

const noopLogger: ConnectorLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

function textMsg(id: string, text: string) {
  return {
    key: { id, remoteJid: "15551234567@s.whatsapp.net", fromMe: false },
    messageTimestamp: 1_700_000_000,
    message: { conversation: text },
  } as never
}

test("emits one envelope per normalizable message", async () => {
  const emitted: InboundEnvelope[] = []
  const seen = new Set<string>()
  await processUpsertBatch([textMsg("A", "one"), textMsg("B", "two")], {
    workspaceId: "ws1",
    emitInbound: async (e) => {
      emitted.push(e)
    },
    download: async () => Buffer.from(""),
    logger: noopLogger,
    seen: (id) => (seen.has(id) ? true : (seen.add(id), false)),
  })
  assert.equal(emitted.length, 2)
  assert.equal(emitted[0].externalMessageId, "A")
  assert.equal(emitted[1].externalMessageId, "B")
})

test("dedup: a seen id is skipped", async () => {
  const emitted: InboundEnvelope[] = []
  await processUpsertBatch([textMsg("DUP", "x"), textMsg("DUP", "x")], {
    workspaceId: "ws1",
    emitInbound: async (e) => {
      emitted.push(e)
    },
    download: async () => Buffer.from(""),
    logger: noopLogger,
    seen: (() => {
      const s = new Set<string>()
      return (id: string) => (s.has(id) ? true : (s.add(id), false))
    })(),
  })
  assert.equal(emitted.length, 1)
})

test("fromMe and non-normalizable messages are skipped", async () => {
  const emitted: InboundEnvelope[] = []
  const fromMe = {
    key: { id: "S", remoteJid: "a@s.whatsapp.net", fromMe: true },
    message: { conversation: "self" },
  } as never
  await processUpsertBatch([fromMe], {
    workspaceId: "ws1",
    emitInbound: async (e) => {
      emitted.push(e)
    },
    download: async () => Buffer.from(""),
    logger: noopLogger,
    seen: () => false,
  })
  assert.equal(emitted.length, 0)
})

test("a media message is enriched via download+store before emit", async () => {
  const emitted: InboundEnvelope[] = []
  const imageMsg = {
    key: { id: "IMG", remoteJid: "15551234567@s.whatsapp.net", fromMe: false },
    messageTimestamp: 1_700_000_000,
    message: { imageMessage: { mimetype: "image/jpeg", fileName: "p.jpg" } },
  } as never
  await processUpsertBatch([imageMsg], {
    workspaceId: "ws1",
    emitInbound: async (e) => {
      emitted.push(e)
    },
    download: async () => Buffer.from("imgbytes"),
    store: async () => ({ sha256: "sha-x" }),
    logger: noopLogger,
    seen: () => false,
  })
  assert.equal(emitted.length, 1)
  const part = emitted[0].message.parts[0]
  assert.ok(part.type === "image")
  assert.equal(part.fileRef.sha256, "sha-x")
})

test("an emit error for one message doesn't drop the rest", async () => {
  const emitted: string[] = []
  let first = true
  await processUpsertBatch([textMsg("A", "1"), textMsg("B", "2")], {
    workspaceId: "ws1",
    emitInbound: async (e) => {
      if (first) {
        first = false
        throw new Error("emit boom")
      }
      emitted.push(e.externalMessageId)
    },
    download: async () => Buffer.from(""),
    logger: noopLogger,
    seen: () => false,
  })
  assert.deepEqual(emitted, ["B"])
})
