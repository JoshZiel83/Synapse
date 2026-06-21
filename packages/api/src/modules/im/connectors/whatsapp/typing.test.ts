import test from "node:test"
import assert from "node:assert/strict"
import { unwrapTypingAdapterResult } from "../types.js"
import { createWhatsappTypingAdapter } from "./typing.js"

const account = {
  id: "acct",
  credentials: {
    phoneNumberId: "PNID",
    wabaId: "W",
    accessToken: "TOK",
    appSecret: "S",
    appId: "A",
    webhookVerifyToken: "V",
    graphApiVersion: "v23.0",
  },
} as never

const endpointRef = {
  endpointType: "direct" as const,
  externalId: "p",
  metadata: {},
}

test("typing: returns null without an inbound message ref", () => {
  const r = createWhatsappTypingAdapter({ account, endpointRef })
  assert.equal(r, null)
})

test("typing: start() sends status:read + typing_indicator for the inbound id", async () => {
  let body: Record<string, unknown> | undefined
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    body = init?.body ? JSON.parse(String(init.body)) : undefined
    return new Response("{}", { status: 200 })
  }) as unknown as typeof fetch

  const result = createWhatsappTypingAdapter({
    account,
    endpointRef,
    lastInboundMessageRef: {
      externalMessageId: "wamid.IN",
      endpointExternalId: "p",
    },
    fetchImpl,
  })
  assert.ok(result)
  const unwrapped = unwrapTypingAdapterResult(result)
  assert.ok(unwrapped)
  // heartbeat override is present (Meta dismisses ~25s).
  assert.equal(unwrapped.config?.heartbeatMs, 20_000)

  await unwrapped.adapter.start()
  assert.equal(body?.status, "read")
  assert.equal(body?.message_id, "wamid.IN")
  assert.deepEqual(body?.typing_indicator, { type: "text" })

  // stop() is a no-op (does not fetch).
  await unwrapped.adapter.stop()
})
