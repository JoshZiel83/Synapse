/**
 * S23: mobile-web main thread vs service-worker mutex.
 *
 * On web platforms the chat service worker is the canonical owner of
 * read-watermark and outbox flushing (provider triggers the SW via
 * requestChatServiceWorkerSync whenever the queue changes). If the
 * main-thread chat-runtime ALSO POSTs the same payload, every read
 * watermark and every outbound message gets sent twice — exactly the
 * regression S6 was meant to close.
 *
 * This test enforces that the main-thread paths in mobile-app's
 * chat-runtime.ts that would POST consult isChatServiceWorkerActive()
 * first and early-return when it is true. We do it via source-text
 * inspection because the runtime is a large stateful class and
 * grep-asserting the guard is cheaper than spinning it up.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const chatRuntimePath = path.resolve(
  here,
  "..",
  "..",
  "..",
  "..",
  "mobile-app",
  "src",
  "lib",
  "chat-runtime.ts"
)

test("mobile chat-runtime imports isChatServiceWorkerActive from the web SW helper", async () => {
  const body = await readFile(chatRuntimePath, "utf8")
  assert.match(
    body,
    /import \{[^}]*isChatServiceWorkerActive[^}]*\}\s+from\s+"@\/lib\/chat-web-service-worker"/s,
    "chat-runtime.ts must import isChatServiceWorkerActive so the main thread can defer to the SW when it is active"
  )
})

test("mobile markConversationRead defers the read-watermark POST when SW is active", async () => {
  const body = await readFile(chatRuntimePath, "utf8")
  const markFnMatch = body.match(/async markConversationRead\([\s\S]*?\n  \}\n/)
  assert.ok(
    markFnMatch,
    "could not find markConversationRead function body in chat-runtime.ts"
  )
  const markFnBody = markFnMatch[0]
  assert.match(
    markFnBody,
    /if \(isChatServiceWorkerActive\(\)\) \{\s*\n\s*return\s*\n\s*\}/,
    "markConversationRead must early-return when the SW is active, before the direct api.updateChatConversationReadWatermark POST"
  )
  // The guard must come BEFORE the POST call site.
  const guardIdx = markFnBody.indexOf("isChatServiceWorkerActive()")
  const postIdx = markFnBody.indexOf("api.updateChatConversationReadWatermark")
  assert.ok(guardIdx >= 0, "SW guard missing")
  assert.ok(postIdx >= 0, "direct POST call site missing")
  assert.ok(
    guardIdx < postIdx,
    "the SW guard must come before the direct api.updateChatConversationReadWatermark call"
  )
})

test("mobile sendMessage defers the flushOutbox when SW is active", async () => {
  const body = await readFile(chatRuntimePath, "utf8")
  const sendFnMatch = body.match(
    /async sendMessage\(conversationId: string, input: ChatComposerSendPayload\) \{[\s\S]*?\n  \}\n/
  )
  assert.ok(
    sendFnMatch,
    "could not find sendMessage function body in chat-runtime.ts"
  )
  const sendFnBody = sendFnMatch[0]
  // Find the position of the optimistic outbox.add call and the SW guard.
  const optimisticIdx = sendFnBody.indexOf("[clientMessageId]: outboxEntry")
  const guardIdx = sendFnBody.indexOf("isChatServiceWorkerActive()")
  const flushIdx = sendFnBody.indexOf("await this.flushOutbox()")
  assert.ok(optimisticIdx >= 0, "could not find optimistic-outbox insert")
  assert.ok(guardIdx >= 0, "SW guard missing in sendMessage")
  assert.ok(flushIdx >= 0, "main-thread flushOutbox call missing")
  assert.ok(
    optimisticIdx < guardIdx && guardIdx < flushIdx,
    "the SW guard must sit between the optimistic write and the flushOutbox call"
  )
})

test("mobile retryMessage defers the flushOutbox when SW is active", async () => {
  const body = await readFile(chatRuntimePath, "utf8")
  const retryFnMatch = body.match(
    /async retryMessage\(clientMessageId: string\) \{[\s\S]*?\n  \}\n/
  )
  assert.ok(
    retryFnMatch,
    "could not find retryMessage function body in chat-runtime.ts"
  )
  const retryFnBody = retryFnMatch[0]
  const guardIdx = retryFnBody.indexOf("isChatServiceWorkerActive()")
  const flushIdx = retryFnBody.indexOf("await this.flushOutbox()")
  assert.ok(guardIdx >= 0, "SW guard missing in retryMessage")
  assert.ok(flushIdx >= 0, "main-thread flushOutbox call missing")
  assert.ok(
    guardIdx < flushIdx,
    "the SW guard must come before the flushOutbox call in retryMessage so an SW-owned retry isn't double-POSTed"
  )
})
