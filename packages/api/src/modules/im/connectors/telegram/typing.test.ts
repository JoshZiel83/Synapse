import test from "node:test"
import assert from "node:assert/strict"
import type { TransportAccountSummary } from "@synapse/shared/types"
import { createTelegramTypingAdapter } from "./typing.js"

const ACCOUNT = {
  credentials: { botToken: "123:ABC" },
} as unknown as TransportAccountSummary

test("createTelegramTypingAdapter: returns adapter + 4s heartbeat config", () => {
  const result = createTelegramTypingAdapter({
    account: ACCOUNT,
    endpointRef: { endpointType: "direct", externalId: "555", metadata: {} },
  })
  assert.ok(result)
  assert.ok("adapter" in result!)
  const wrapped = result as {
    adapter: { start: () => Promise<void>; stop: () => Promise<void> }
    config?: { heartbeatMs?: number }
  }
  assert.equal(wrapped.config?.heartbeatMs, 4000)
  assert.equal(typeof wrapped.adapter.start, "function")
  assert.equal(typeof wrapped.adapter.stop, "function")
})

test("createTelegramTypingAdapter: null when no chat id", () => {
  const result = createTelegramTypingAdapter({
    account: ACCOUNT,
    endpointRef: { endpointType: "direct", externalId: "", metadata: {} },
  })
  assert.equal(result, null)
})

test("typing adapter start: calls sendChatAction(typing)", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({
      method: String(url).split("/").pop() ?? "",
      body: init?.body ? JSON.parse(String(init.body)) : {},
    })
    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
  try {
    const result = createTelegramTypingAdapter({
      account: ACCOUNT,
      endpointRef: { endpointType: "direct", externalId: "555", metadata: {} },
    })
    const wrapped = result as { adapter: { start: () => Promise<void> } }
    await wrapped.adapter.start()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, "sendChatAction")
    assert.equal(calls[0].body.action, "typing")
    assert.equal(calls[0].body.chat_id, "555")
  } finally {
    globalThis.fetch = orig
  }
})
