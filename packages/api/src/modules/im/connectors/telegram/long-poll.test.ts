import test from "node:test"
import assert from "node:assert/strict"
import type { TransportAccountSummary } from "@synapse/shared/types"
import type { InboundEnvelope } from "../types.js"
import { startTelegramLongPoll } from "./long-poll.js"

const ACCOUNT = {
  id: "acc",
  connectionMode: "long_connection",
  workspaceId: "ws",
  credentials: { botToken: "123:ABC" },
} as unknown as TransportAccountSummary

const NOOP_LOGGER = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

test("long-poll: first poll deletes webhook + sends allowed_updates; advances offset; emits", async () => {
  const controller = new AbortController()
  const calls: Array<{ method: string; body: Record<string, unknown> }> = []
  const emitted: InboundEnvelope[] = []
  let storedOffset = 0

  const orig = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = String(url).split("/").pop() ?? ""
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    calls.push({ method, body })
    if (method === "deleteWebhook")
      return jsonResponse({ ok: true, result: true })
    if (method === "getUpdates") {
      const getUpdatesCalls = calls.filter(
        (c) => c.method === "getUpdates"
      ).length
      if (getUpdatesCalls === 1) {
        // First batch: one message update.
        return jsonResponse({
          ok: true,
          result: [
            {
              update_id: 50,
              message: {
                message_id: 1,
                date: 1_700_000_000,
                chat: { id: 555, type: "private", first_name: "A" },
                from: { id: 777, first_name: "A" },
                text: "hi",
              },
            },
          ],
        })
      }
      // Second poll: empty + abort so the loop exits.
      controller.abort()
      return jsonResponse({ ok: true, result: [] })
    }
    return jsonResponse({ ok: true, result: true })
  }) as typeof fetch

  try {
    const running = await startTelegramLongPoll(
      {
        account: ACCOUNT,
        signal: controller.signal,
        emitInbound: async (e) => {
          emitted.push(e)
        },
        logger: NOOP_LOGGER,
      },
      {
        getOffset: async () => storedOffset,
        setOffset: async (_id, off) => {
          storedOffset = off
        },
        enrich: async (e) => e,
      }
    )
    await running.stop()
  } finally {
    globalThis.fetch = orig
  }

  // deleteWebhook ran once, before the first getUpdates.
  assert.equal(calls[0].method, "deleteWebhook")
  const firstGet = calls.find((c) => c.method === "getUpdates")!
  assert.ok(Array.isArray(firstGet.body.allowed_updates))
  assert.ok(
    (firstGet.body.allowed_updates as string[]).includes("message_reaction")
  )
  // Offset advanced to max(update_id)+1.
  assert.equal(storedOffset, 51)
  // One inbound emitted.
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].externalMessageId, "1")
})

test("long-poll: 401 is fatal (loop throws, does not spin)", async () => {
  const controller = new AbortController()
  const orig = globalThis.fetch
  let getUpdatesCount = 0
  globalThis.fetch = (async (url: string) => {
    const method = String(url).split("/").pop() ?? ""
    if (method === "getUpdates") {
      getUpdatesCount += 1
      return jsonResponse({
        ok: false,
        error_code: 401,
        description: "Unauthorized",
      })
    }
    return jsonResponse({ ok: true, result: true })
  }) as typeof fetch

  try {
    const running = await startTelegramLongPoll(
      {
        account: ACCOUNT,
        signal: controller.signal,
        emitInbound: async () => {},
        logger: NOOP_LOGGER,
      },
      {
        getOffset: async () => 0,
        setOffset: async () => {},
        enrich: async (e) => e,
      }
    )
    // stop() drains the loop; the loop rejected on the fatal 401.
    await running.stop()
  } finally {
    globalThis.fetch = orig
  }
  // Fatal error means getUpdates was attempted once and not retried in a spin.
  assert.equal(getUpdatesCount, 1)
})
