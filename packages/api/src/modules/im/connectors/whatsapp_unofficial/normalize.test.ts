import test from "node:test"
import assert from "node:assert/strict"
import {
  normalizeWhatsappMessage,
  parseWhatsappMentions,
  pickContentType,
  renderWhatsappMention,
  type WaMessageLike,
} from "./normalize.js"

function direct(overrides: Partial<WaMessageLike> = {}): WaMessageLike {
  return {
    key: { id: "MSG1", remoteJid: "15551234567@s.whatsapp.net", fromMe: false },
    messageTimestamp: 1_700_000_000,
    message: { conversation: "hello" },
    pushName: "Alice",
    ...overrides,
  }
}

test("direct text → single text part, direct endpoint, sender = remoteJid", () => {
  const r = normalizeWhatsappMessage(direct())
  assert.ok(r)
  assert.equal(r.envelope.endpointType, "direct")
  assert.equal(r.envelope.endpointExternalId, "15551234567@s.whatsapp.net")
  assert.equal(r.envelope.sender.externalId, "15551234567@s.whatsapp.net")
  assert.equal(r.envelope.sender.displayName, "Alice")
  assert.equal(r.envelope.externalMessageId, "MSG1")
  assert.equal(r.envelope.message.parts.length, 1)
  assert.equal(r.envelope.message.plainText, "hello")
})

test("receivedAt is an ISO instant (fromUnixSeconds), not epoch ms", () => {
  const r = normalizeWhatsappMessage(
    direct({ messageTimestamp: 1_700_000_000 })
  )
  assert.ok(r)
  // 1_700_000_000s = 2023-11-14T22:13:20.000Z
  assert.equal(typeof r.envelope.receivedAt, "string")
  assert.match(String(r.envelope.receivedAt), /^2023-11-14T22:13:20/)
})

test("fromMe is dropped", () => {
  assert.equal(
    normalizeWhatsappMessage(
      direct({ key: { id: "X", remoteJid: "a@s.whatsapp.net", fromMe: true } })
    ),
    null
  )
})

test("blank message id is dropped (would disable dedup)", () => {
  assert.equal(
    normalizeWhatsappMessage(
      direct({ key: { id: "", remoteJid: "a@s.whatsapp.net", fromMe: false } })
    ),
    null
  )
})

test("broadcast and newsletter JIDs are dropped", () => {
  assert.equal(
    normalizeWhatsappMessage(
      direct({ key: { id: "X", remoteJid: "status@broadcast", fromMe: false } })
    ),
    null
  )
  assert.equal(
    normalizeWhatsappMessage(
      direct({ key: { id: "X", remoteJid: "x@newsletter", fromMe: false } })
    ),
    null
  )
})

test("group message: endpoint = group jid, sender = participant", () => {
  const r = normalizeWhatsappMessage(
    direct({
      key: {
        id: "G1",
        remoteJid: "111-222@g.us",
        fromMe: false,
        participant: "15559998888@s.whatsapp.net",
      },
    })
  )
  assert.ok(r)
  assert.equal(r.envelope.endpointType, "group")
  assert.equal(r.envelope.endpointExternalId, "111-222@g.us")
  assert.equal(r.envelope.sender.externalId, "15559998888@s.whatsapp.net")
})

test("extendedTextMessage carries mentions + reply-to (stanzaId)", () => {
  const r = normalizeWhatsappMessage(
    direct({
      message: {
        extendedTextMessage: {
          text: "hey @123",
          contextInfo: {
            stanzaId: "REPLIED",
            mentionedJid: ["15550001111@s.whatsapp.net"],
          },
        },
      },
    })
  )
  assert.ok(r)
  assert.equal(r.envelope.externalReplyToId, "REPLIED")
  const mention = r.envelope.message.parts.find((p) => p.type === "mention")
  assert.ok(mention && mention.type === "mention")
  assert.equal(mention.externalId, "15550001111@s.whatsapp.net")
})

test("image message → image_placeholder + media key + caption text", () => {
  const r = normalizeWhatsappMessage(
    direct({
      message: {
        imageMessage: {
          caption: "look",
          mimetype: "image/jpeg",
          fileLength: "2048",
        },
      },
    })
  )
  assert.ok(r)
  assert.equal(r.mediaParts.length, 1)
  assert.equal(r.mediaParts[0].kind, "image")
  const ph = r.envelope.message.parts[r.mediaParts[0].partIndex]
  assert.ok(ph && ph.type === "system_marker")
  assert.equal(ph.marker, "image_placeholder")
  assert.equal((ph.original as Record<string, unknown>).fileLength, 2048)
  // caption appended as a text part
  assert.ok(r.envelope.message.parts.some((p) => p.type === "text"))
})

test("audio message → voice_placeholder media key", () => {
  const r = normalizeWhatsappMessage(
    direct({ message: { audioMessage: { mimetype: "audio/ogg", seconds: 3 } } })
  )
  assert.ok(r)
  assert.equal(r.mediaParts[0].kind, "audio")
  const ph = r.envelope.message.parts[0]
  assert.ok(ph && ph.type === "system_marker")
  assert.equal(ph.marker, "voice_placeholder")
})

test("pure reaction message is not an inbound message", () => {
  const r = normalizeWhatsappMessage(
    direct({ message: { reactionMessage: { text: "👍", key: { id: "T" } } } })
  )
  assert.equal(r, null)
})

test("pickContentType returns the first present content key", () => {
  assert.equal(pickContentType({ conversation: "x" }), "conversation")
  assert.equal(pickContentType({ imageMessage: {} }), "imageMessage")
  assert.equal(pickContentType({}), undefined)
  assert.equal(pickContentType(null), undefined)
})

test("renderWhatsappMention uses the number", () => {
  assert.equal(
    renderWhatsappMention({
      externalId: "15551234567@s.whatsapp.net",
      displayName: "Bob",
    }),
    "@15551234567"
  )
})

test("parseWhatsappMentions extracts mentionedJid", () => {
  const r = parseWhatsappMentions(["15550001111@s.whatsapp.net", 42])
  assert.equal(r.mentions.length, 1)
  assert.equal(r.mentions[0].externalId, "15550001111@s.whatsapp.net")
  assert.equal(parseWhatsappMentions(undefined).mentions.length, 0)
})
