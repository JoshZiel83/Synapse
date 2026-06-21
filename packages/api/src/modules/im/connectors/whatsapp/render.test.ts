import test from "node:test"
import assert from "node:assert/strict"
import { buildCanonicalMessage } from "../../messaging/canonical-message.js"
import { degradeForCapabilities } from "../../messaging/degradation.js"
import { WHATSAPP_MESSAGE_CAPABILITIES } from "./capabilities.js"
import { planWhatsappSends } from "./render.js"

test("render: adjacent text coalesces into one text send", () => {
  const msg = buildCanonicalMessage([
    { type: "text", text: "hello" },
    { type: "text", text: "world" },
  ])
  const items = planWhatsappSends(msg)
  assert.equal(items.length, 1)
  assert.deepEqual(items[0], { kind: "text", text: "hello world" })
})

test("render: mixed text + image + voice → ordered (text, image, voice)", () => {
  const msg = buildCanonicalMessage([
    { type: "text", text: "see this" },
    { type: "image", fileRef: { sha256: "img" } },
    { type: "voice", fileRef: { sha256: "aud" } },
  ])
  const items = planWhatsappSends(msg)
  assert.equal(items.length, 3)
  assert.equal(items[0]?.kind, "text")
  assert.equal(items[1]?.kind, "media")
  assert.equal((items[1] as { messageType: string }).messageType, "image")
  assert.equal(items[2]?.kind, "media")
  assert.equal((items[2] as { messageType: string }).messageType, "audio")
  assert.equal((items[2] as { voice?: boolean }).voice, true)
})

test("render: media without sha256 is dropped", () => {
  const msg = buildCanonicalMessage([
    { type: "image", fileRef: {} },
    { type: "text", text: "fallback" },
  ])
  const items = planWhatsappSends(msg)
  assert.equal(items.length, 1)
  assert.equal(items[0]?.kind, "text")
})

test("render: reaction → reaction send item", () => {
  const msg = buildCanonicalMessage([
    {
      type: "reaction",
      emoji: "❤️",
      target: { externalMessageId: "wamid.A" },
    },
  ])
  const items = planWhatsappSends(msg)
  assert.equal(items.length, 1)
  assert.deepEqual(items[0], {
    kind: "reaction",
    targetExternalMessageId: "wamid.A",
    emoji: "❤️",
  })
})

test("render: document carries filename", () => {
  const msg = buildCanonicalMessage([
    { type: "file", fileRef: { sha256: "doc", name: "report.pdf" } },
  ])
  const items = planWhatsappSends(msg)
  assert.equal(items.length, 1)
  assert.equal((items[0] as { messageType: string }).messageType, "document")
  assert.equal((items[0] as { filename?: string }).filename, "report.pdf")
})

test("render: degradation interaction — card degrades to its fallback text before render", () => {
  const msg = buildCanonicalMessage([
    {
      type: "card",
      schema: "feishu_interactive_v1",
      payload: {},
      fallbackText: "card text",
    },
  ])
  const degraded = degradeForCapabilities(msg, WHATSAPP_MESSAGE_CAPABILITIES)
  const items = planWhatsappSends(degraded)
  assert.equal(items.length, 1)
  assert.deepEqual(items[0], { kind: "text", text: "card text" })
})
