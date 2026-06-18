import test from "node:test"
import assert from "node:assert/strict"
import { buildCanonicalMessage } from "../../messaging/canonical-message.js"
import type { TransportAccountSummary } from "@synapse/shared/types"
import {
  PermanentTransportError,
  RetryableTransportError,
  type OutboundSendInput,
} from "../types.js"
import { sendTelegramMessage } from "./outbound.js"

const ACCOUNT = {
  id: "acc",
  connectionMode: "long_connection",
  credentials: { botToken: "123:ABC" },
} as unknown as TransportAccountSummary

function inputFor(
  parts: Parameters<typeof buildCanonicalMessage>[0],
  over: Partial<OutboundSendInput> = {}
): OutboundSendInput {
  return {
    account: ACCOUNT,
    endpoint: { endpointType: "direct", externalId: "555", metadata: {} },
    message: buildCanonicalMessage(parts),
    transportMessageLinkId: "link-1",
    linkMetadata: {},
    attemptNumber: 0,
    patchLinkMetadata: async () => {},
    ...over,
  }
}

function withFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
  run: () => Promise<void>
): Promise<void> {
  const orig = globalThis.fetch
  globalThis.fetch = impl as typeof fetch
  return run().finally(() => {
    globalThis.fetch = orig
  })
}

function okResponse(messageId: number): Response {
  return new Response(
    JSON.stringify({ ok: true, result: { message_id: messageId } }),
    { status: 200, headers: { "content-type": "application/json" } }
  )
}

function errResponse(code: number, params?: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error_code: code,
      description: `error ${code}`,
      parameters: params,
    }),
    { status: code, headers: { "content-type": "application/json" } }
  )
}

test("sendTelegramMessage: text send returns first message_id", async () => {
  let body: Record<string, unknown> = {}
  await withFetch(
    async (_url, init) => {
      body = init?.body ? JSON.parse(String(init.body)) : {}
      return okResponse(321)
    },
    async () => {
      const r = await sendTelegramMessage(
        inputFor([{ type: "text", text: "hi" }])
      )
      assert.equal(r.externalMessageId, "321")
      assert.equal(body.parse_mode, "HTML")
      assert.equal(body.chat_id, "555")
    }
  )
})

test("sendTelegramMessage: replyTo sets reply_parameters on first item", async () => {
  let body: Record<string, unknown> = {}
  await withFetch(
    async (_url, init) => {
      body = init?.body ? JSON.parse(String(init.body)) : {}
      return okResponse(1)
    },
    async () => {
      await sendTelegramMessage(
        inputFor([{ type: "text", text: "re" }], {
          replyTo: { externalMessageId: "50", endpointExternalId: "555" },
        })
      )
      assert.deepEqual(body.reply_parameters, { message_id: 50 })
    }
  )
})

test("sendTelegramMessage: empty message => PermanentTransportError", async () => {
  await assert.rejects(
    () => sendTelegramMessage(inputFor([])),
    (err: unknown) => {
      assert.ok(err instanceof PermanentTransportError)
      assert.equal(
        (err as PermanentTransportError).code,
        "telegram_empty_message"
      )
      return true
    }
  )
})

test("sendTelegramMessage: 429 => RetryableTransportError", async () => {
  await withFetch(
    async () => errResponse(429, { retry_after: 5 }),
    async () => {
      await assert.rejects(
        () => sendTelegramMessage(inputFor([{ type: "text", text: "x" }])),
        RetryableTransportError
      )
    }
  )
})

test("sendTelegramMessage: 500 => RetryableTransportError", async () => {
  await withFetch(
    async () => errResponse(500),
    async () => {
      await assert.rejects(
        () => sendTelegramMessage(inputFor([{ type: "text", text: "x" }])),
        RetryableTransportError
      )
    }
  )
})

test("sendTelegramMessage: 403 business error => PermanentTransportError telegram_403", async () => {
  await withFetch(
    async () => errResponse(403),
    async () => {
      await assert.rejects(
        () => sendTelegramMessage(inputFor([{ type: "text", text: "x" }])),
        (err: unknown) => {
          assert.ok(err instanceof PermanentTransportError)
          assert.equal((err as PermanentTransportError).code, "telegram_403")
          return true
        }
      )
    }
  )
})

test("sendTelegramMessage: migrate_to_chat_id => swap chat_id and retry", async () => {
  const chatIds: unknown[] = []
  let call = 0
  await withFetch(
    async (_url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      chatIds.push(body.chat_id)
      call += 1
      if (call === 1) return errResponse(400, { migrate_to_chat_id: -1009 })
      return okResponse(7)
    },
    async () => {
      const r = await sendTelegramMessage(
        inputFor([{ type: "text", text: "x" }])
      )
      assert.equal(r.externalMessageId, "7")
      assert.deepEqual(chatIds, ["555", "-1009"])
    }
  )
})
