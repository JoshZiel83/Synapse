import test from "node:test"
import assert from "node:assert/strict"
import {
  normalizeWhatsappMessage,
  whatsappMessageInstant,
} from "./normalize.js"
import type { WhatsappInboundMessage } from "./types.js"

const TS = "1700000000" // Unix seconds

function base(extra: Partial<WhatsappInboundMessage>): WhatsappInboundMessage {
  return { id: "wamid.X", from: "15551230000", timestamp: TS, ...extra }
}

test("normalize: text message → text part + direct endpoint = wa_id", () => {
  const e = normalizeWhatsappMessage(
    base({ type: "text", text: { body: "hi there" } }),
    { contactName: "Alice" }
  )
  assert.ok(e)
  assert.equal(e.endpointType, "direct")
  assert.equal(e.endpointExternalId, "15551230000")
  assert.equal(e.externalMessageId, "wamid.X")
  assert.equal(e.sender.externalId, "15551230000")
  assert.equal(e.endpointDisplayName, "Alice")
  assert.equal(e.message.plainText, "hi there")
  // receivedAt is an ISO instant (fromUnixSeconds), NOT a number.
  assert.equal(typeof e.receivedAt, "string")
  assert.ok(e.receivedAt.startsWith("2023-"))
})

test("normalize: blank id or from → null (dedup-safe)", () => {
  assert.equal(normalizeWhatsappMessage(base({ id: "", type: "text" })), null)
  assert.equal(
    normalizeWhatsappMessage(base({ from: "  ", type: "text" })),
    null
  )
})

test("normalize: image → image_placeholder stashing media_id + mime", () => {
  const e = normalizeWhatsappMessage(
    base({
      type: "image",
      image: { id: "media-1", mime_type: "image/png", caption: "look" },
    })
  )
  assert.ok(e)
  const parts = e.message.parts
  const marker = parts.find((p) => p.type === "system_marker")
  assert.ok(marker && marker.type === "system_marker")
  assert.equal(marker.marker, "image_placeholder")
  assert.equal(marker.original?.media_id, "media-1")
  assert.equal(marker.original?.mime_type, "image/png")
  // caption rides along as a text part
  assert.ok(parts.some((p) => p.type === "text" && p.text === "look"))
})

test("normalize: audio voice note → voice_placeholder with voice flag", () => {
  const e = normalizeWhatsappMessage(
    base({
      type: "audio",
      audio: { id: "m2", mime_type: "audio/ogg", voice: true },
    })
  )!
  const marker = e.message.parts.find((p) => p.type === "system_marker")
  assert.ok(marker && marker.type === "system_marker")
  assert.equal(marker.marker, "voice_placeholder")
  assert.equal(marker.original?.voice, true)
})

test("normalize: document → file_placeholder with filename", () => {
  const e = normalizeWhatsappMessage(
    base({
      type: "document",
      document: { id: "m3", mime_type: "application/pdf", filename: "x.pdf" },
    })
  )!
  const marker = e.message.parts.find((p) => p.type === "system_marker")
  assert.ok(marker && marker.type === "system_marker")
  assert.equal(marker.marker, "file_placeholder")
  assert.equal(marker.original?.filename, "x.pdf")
})

test("normalize: sticker → image_placeholder (sticker flag set)", () => {
  const e = normalizeWhatsappMessage(
    base({ type: "sticker", sticker: { id: "m4", mime_type: "image/webp" } })
  )!
  const marker = e.message.parts.find((p) => p.type === "system_marker")
  assert.ok(marker && marker.type === "system_marker")
  assert.equal(marker.marker, "image_placeholder")
  assert.equal(marker.original?.sticker, true)
})

test("normalize: reaction → reaction part targeting message_id", () => {
  const e = normalizeWhatsappMessage(
    base({
      type: "reaction",
      reaction: { message_id: "wamid.PARENT", emoji: "👍" },
    })
  )!
  const reaction = e.message.parts.find((p) => p.type === "reaction")
  assert.ok(reaction && reaction.type === "reaction")
  assert.equal(reaction.emoji, "👍")
  assert.equal(reaction.target.externalMessageId, "wamid.PARENT")
})

test("normalize: location → text part", () => {
  const e = normalizeWhatsappMessage(
    base({
      type: "location",
      location: { latitude: 37.4, longitude: -122.1, name: "HQ" },
    })
  )!
  assert.ok(e.message.plainText.includes("37.4"))
  assert.ok(e.message.plainText.includes("HQ"))
})

test("normalize: context.id surfaces as externalReplyToId", () => {
  const e = normalizeWhatsappMessage(
    base({ type: "text", text: { body: "re" }, context: { id: "wamid.Q" } })
  )!
  assert.equal(e.externalReplyToId, "wamid.Q")
})

test("whatsappMessageInstant: absent/garbage timestamp falls back without throwing", () => {
  // present + valid
  assert.ok(whatsappMessageInstant(TS).startsWith("2023-"))
  // absent → server-receive instant (a non-empty ISO string)
  assert.equal(typeof whatsappMessageInstant(undefined), "string")
  // garbage → does not throw
  assert.equal(typeof whatsappMessageInstant("not-a-number"), "string")
})
