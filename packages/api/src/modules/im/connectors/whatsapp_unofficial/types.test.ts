import test from "node:test"
import assert from "node:assert/strict"
import {
  classifyJid,
  coerceFileLength,
  e164ForPairing,
  endpointTypeForJid,
  jidFromE164,
  jidUser,
  mediaKindForContentType,
  normalizeJid,
} from "./types.js"

test("classifyJid maps suffixes", () => {
  assert.equal(classifyJid("15551234567@s.whatsapp.net"), "direct")
  assert.equal(classifyJid("123-456@g.us"), "group")
  assert.equal(classifyJid("abc@lid"), "lid")
  assert.equal(classifyJid("status@broadcast"), "broadcast")
  assert.equal(classifyJid("x@newsletter"), "other")
  assert.equal(classifyJid(undefined), "other")
})

test("endpointTypeForJid: group→group, everything else→direct", () => {
  assert.equal(endpointTypeForJid("g@g.us"), "group")
  assert.equal(endpointTypeForJid("u@s.whatsapp.net"), "direct")
  assert.equal(endpointTypeForJid("u@lid"), "direct")
  assert.equal(endpointTypeForJid(undefined), "direct")
})

test("normalizeJid strips device suffix", () => {
  assert.equal(
    normalizeJid("15551234567:12@s.whatsapp.net"),
    "15551234567@s.whatsapp.net"
  )
  assert.equal(
    normalizeJid("15551234567@s.whatsapp.net"),
    "15551234567@s.whatsapp.net"
  )
  assert.equal(normalizeJid(""), "")
})

test("jidUser + jidFromE164 + e164ForPairing", () => {
  assert.equal(jidUser("15551234567@s.whatsapp.net"), "15551234567")
  assert.equal(jidFromE164("+1 (555) 123-4567"), "15551234567@s.whatsapp.net")
  assert.equal(e164ForPairing("+15551234567"), "15551234567")
})

test("mediaKindForContentType", () => {
  assert.equal(mediaKindForContentType("imageMessage"), "image")
  assert.equal(mediaKindForContentType("videoMessage"), "video")
  assert.equal(mediaKindForContentType("audioMessage"), "audio")
  assert.equal(mediaKindForContentType("documentMessage"), "document")
  assert.equal(mediaKindForContentType("stickerMessage"), "sticker")
  assert.equal(mediaKindForContentType("conversation"), null)
  assert.equal(mediaKindForContentType(undefined), null)
})

test("coerceFileLength handles number, string, and Long", () => {
  assert.equal(coerceFileLength(1234), 1234)
  assert.equal(coerceFileLength("5678"), 5678)
  assert.equal(coerceFileLength({ low: 1000, high: 0, unsigned: true }), 1000)
  assert.equal(coerceFileLength("not-a-number"), undefined)
  assert.equal(coerceFileLength(undefined), undefined)
  assert.equal(coerceFileLength(null), undefined)
})
