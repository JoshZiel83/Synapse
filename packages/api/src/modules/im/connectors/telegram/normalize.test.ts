import test from "node:test"
import assert from "node:assert/strict"
import { normalizeTelegramMessage } from "./normalize.js"
import type { TelegramMessage } from "./types.js"

function baseMessage(over: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 100,
    date: 1_700_000_000, // Unix seconds
    chat: { id: 555, type: "private", first_name: "Alice" },
    from: { id: 777, first_name: "Alice", username: "alice" },
    ...over,
  }
}

test("normalizeTelegramMessage: text private message", () => {
  const env = normalizeTelegramMessage(baseMessage({ text: "hello" }))
  assert.ok(env)
  assert.equal(env!.endpointType, "direct")
  assert.equal(env!.endpointExternalId, "555")
  assert.equal(env!.externalMessageId, "100")
  assert.equal(env!.sender.externalId, "777")
  // receivedAt is an ISO instant from fromUnixSeconds (seconds -> ISO).
  assert.equal(env!.receivedAt, "2023-11-14T22:13:20.000Z")
  assert.equal(env!.message.plainText.includes("hello"), true)
})

test("normalizeTelegramMessage: group chat => group endpointType", () => {
  const env = normalizeTelegramMessage(
    baseMessage({
      text: "hi",
      chat: { id: -100, type: "supergroup", title: "Devs" },
    })
  )
  assert.equal(env!.endpointType, "group")
  assert.equal(env!.endpointDisplayName, "Devs")
})

test("normalizeTelegramMessage: photo => image_placeholder with file_id", () => {
  const env = normalizeTelegramMessage(
    baseMessage({
      photo: [
        { file_id: "small", file_unique_id: "us", width: 90, height: 90 },
        { file_id: "big", file_unique_id: "ub", width: 1280, height: 720 },
      ],
    })
  )
  const part = env!.message.parts.find((p) => p.type === "system_marker")
  assert.ok(part && part.type === "system_marker")
  assert.equal(part.marker, "image_placeholder")
  // Largest photo selected.
  assert.equal((part.original as Record<string, unknown>).file_id, "big")
  assert.equal((part.original as Record<string, unknown>).width, 1280)
})

test("normalizeTelegramMessage: voice => voice_placeholder w/ duration", () => {
  const env = normalizeTelegramMessage(
    baseMessage({
      voice: {
        file_id: "v",
        file_unique_id: "uv",
        duration: 7,
        mime_type: "audio/ogg",
      },
    })
  )
  const part = env!.message.parts.find((p) => p.type === "system_marker")
  assert.ok(part && part.type === "system_marker")
  assert.equal(part.marker, "voice_placeholder")
  assert.equal((part.original as Record<string, unknown>).duration, 7)
})

test("normalizeTelegramMessage: document => file_placeholder", () => {
  const env = normalizeTelegramMessage(
    baseMessage({
      document: {
        file_id: "d",
        file_unique_id: "ud",
        file_name: "report.pdf",
        mime_type: "application/pdf",
      },
    })
  )
  const part = env!.message.parts.find((p) => p.type === "system_marker")
  assert.ok(part && part.type === "system_marker")
  assert.equal(part.marker, "file_placeholder")
  assert.equal((part.original as Record<string, unknown>).name, "report.pdf")
})

test("normalizeTelegramMessage: reply_to sets externalReplyToId", () => {
  const env = normalizeTelegramMessage(
    baseMessage({
      text: "re",
      reply_to_message: baseMessage({ message_id: 50 }),
    })
  )
  assert.equal(env!.externalReplyToId, "50")
})

test("normalizeTelegramMessage: empty/serviceless message => null", () => {
  const env = normalizeTelegramMessage(baseMessage({}))
  assert.equal(env, null)
})

test("normalizeTelegramMessage: missing chat => null", () => {
  const env = normalizeTelegramMessage({
    message_id: 1,
    date: 1,
  } as unknown as TelegramMessage)
  assert.equal(env, null)
})
