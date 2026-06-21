import test from "node:test"
import assert from "node:assert/strict"
import { buildCanonicalMessage } from "../../messaging/canonical-message.js"
import { planTelegramSends } from "./render.js"

test("planTelegramSends: plain text => one HTML text item", () => {
  const msg = buildCanonicalMessage([{ type: "text", text: "hi <there>" }])
  const items = planTelegramSends(msg)
  assert.equal(items.length, 1)
  assert.deepEqual(items[0], { kind: "text", html: "hi &lt;there&gt;" })
})

test("planTelegramSends: mention rendered as anchor in text item", () => {
  const msg = buildCanonicalMessage([
    { type: "mention", externalId: "42", displayName: "Bob" },
    { type: "text", text: " hello" },
  ])
  const items = planTelegramSends(msg)
  assert.equal(items.length, 1)
  assert.ok(items[0].kind === "text")
  assert.ok(
    (items[0] as { html: string }).html.includes(
      '<a href="tg://user?id=42">Bob</a>'
    )
  )
})

test("planTelegramSends: text + image => ordered (text, photo)", () => {
  const msg = buildCanonicalMessage([
    { type: "text", text: "look" },
    { type: "image", fileRef: { sha256: "abc", mimeType: "image/png" } },
  ])
  const items = planTelegramSends(msg)
  assert.equal(items.length, 2)
  assert.equal(items[0].kind, "text")
  assert.equal(items[1].kind, "photo")
})

test("planTelegramSends: voice with durationMs => durationSec", () => {
  const msg = buildCanonicalMessage([
    { type: "voice", fileRef: { sha256: "v" }, durationMs: 5000 },
  ])
  const items = planTelegramSends(msg)
  assert.equal(items.length, 1)
  assert.ok(items[0].kind === "voice")
  assert.equal((items[0] as { durationSec?: number }).durationSec, 5)
})

test("planTelegramSends: media without sha256 dropped", () => {
  const msg = buildCanonicalMessage([
    { type: "image", fileRef: { mimeType: "image/png" } },
  ])
  assert.deepEqual(planTelegramSends(msg), [])
})

test("planTelegramSends: file => document item", () => {
  const msg = buildCanonicalMessage([
    { type: "file", fileRef: { sha256: "f", name: "a.pdf" } },
  ])
  const items = planTelegramSends(msg)
  assert.equal(items[0].kind, "document")
})

test("planTelegramSends: long text splits into multiple text items", () => {
  const long = "x".repeat(5000)
  const msg = buildCanonicalMessage([{ type: "text", text: long }])
  const items = planTelegramSends(msg)
  assert.ok(items.length >= 2)
  assert.ok(items.every((i) => i.kind === "text"))
})
