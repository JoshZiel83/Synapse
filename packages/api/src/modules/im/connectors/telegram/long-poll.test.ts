import test from "node:test"
import assert from "node:assert/strict"
import { context } from "@opentelemetry/api"
import { isTracingSuppressed } from "@opentelemetry/core"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
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

test("long-poll: 401 is fatal — loop returns gracefully and stop() skips the confirm poll", async () => {
  // The fatal-exit path must NOT throw out of the detached loop (which would
  // surface as an unhandled rejection) AND stop() must skip its best-effort
  // confirm getUpdates (the token is dead — confirming would just 401 again).
  // We pin a NON-ZERO persisted offset (50): without the `fatal` guard, stop()
  // would issue a confirm getUpdates(offset:50, limit:1) on the dead token.
  const controller = new AbortController()
  const orig = globalThis.fetch
  let getUpdatesCount = 0
  const getUpdatesBodies: Array<Record<string, unknown>> = []
  // Surface any unhandled rejection from a stray `throw err` in the loop.
  const rejections: unknown[] = []
  const onRejection = (e: unknown) => rejections.push(e)
  process.on("unhandledRejection", onRejection)
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = String(url).split("/").pop() ?? ""
    if (method === "getUpdates") {
      getUpdatesCount += 1
      getUpdatesBodies.push(init?.body ? JSON.parse(String(init.body)) : {})
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
        getOffset: async () => 50,
        setOffset: async () => {},
        enrich: async (e) => e,
      }
    )
    // stop() drains the loop; the loop returned gracefully on the fatal 401.
    await running.stop()
    // Let any (incorrectly) unhandled rejection settle onto the microtask queue.
    await new Promise((r) => setTimeout(r, 0))
  } finally {
    globalThis.fetch = orig
    process.off("unhandledRejection", onRejection)
  }
  // Exactly ONE getUpdates: the fatal poll. No spin-retry, and crucially NO
  // second confirm-poll from stop() (which the `fatal` flag suppresses).
  assert.equal(getUpdatesCount, 1)
  // The single getUpdates is the long-poll (timeout=30), not the confirm
  // (limit:1, timeout:0) — proving stop() skipped the confirm on fatal exit.
  assert.notEqual(getUpdatesBodies[0]?.limit, 1)
  // The detached loop must not have thrown an unhandled rejection.
  assert.deepEqual(rejections, [])
})

test("long-poll: a dispatch error still advances+persists the offset (no redelivery) and the batch continues", async () => {
  // One batch of two updates; dispatch of the FIRST throws (enrich rejects).
  // The offset must already be persisted to max(update_id)+1 BEFORE dispatch,
  // so neither update is redelivered, and the second still emits.
  const controller = new AbortController()
  const orig = globalThis.fetch
  let storedOffset = 0
  const emitted: InboundEnvelope[] = []

  globalThis.fetch = (async (url: string) => {
    const method = String(url).split("/").pop() ?? ""
    if (method === "deleteWebhook")
      return jsonResponse({ ok: true, result: true })
    if (method === "getUpdates") {
      const isFirst = emitted.length === 0 && storedOffset === 0
      if (isFirst) {
        return jsonResponse({
          ok: true,
          result: [
            {
              update_id: 10,
              message: {
                message_id: 1,
                date: 1_700_000_000,
                chat: { id: 5, type: "private", first_name: "A" },
                from: { id: 7, first_name: "A" },
                text: "boom",
              },
            },
            {
              update_id: 11,
              message: {
                message_id: 2,
                date: 1_700_000_001,
                chat: { id: 5, type: "private", first_name: "A" },
                from: { id: 7, first_name: "A" },
                text: "ok",
              },
            },
          ],
        })
      }
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
        // Enrich throws for the first message (id 1) → dispatch error path.
        enrich: async (e) => {
          if (e.externalMessageId === "1") throw new Error("enrich failed")
          return e
        },
      }
    )
    await running.stop()
  } finally {
    globalThis.fetch = orig
  }

  // Offset advanced past BOTH updates even though the first dispatch threw.
  assert.equal(storedOffset, 12)
  // The second update still emitted (batch did not abort on the first error).
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].externalMessageId, "2")
})

test("long-poll: getUpdates (loop poll AND stop confirm) run tracing-suppressed; dispatch does not", async () => {
  // The poll transport is trace-dark: at 100% sampling every getUpdates cycle
  // would otherwise emit a fresh-root CLIENT span (~2-3k/day/account of pure
  // noise). Suppression must cover BOTH getUpdates call sites (the loop poll
  // and stop()'s confirm) and NOTHING else — inbound dispatch (emitInbound)
  // must run OUTSIDE the suppressed context so message-level instrumentation
  // stays live. A real context manager is required: without one,
  // context.active() is always ROOT_CONTEXT and suppression is unobservable.
  const contextManager = new AsyncLocalStorageContextManager().enable()
  context.setGlobalContextManager(contextManager)

  const controller = new AbortController()
  const calls: Array<{
    method: string
    body: Record<string, unknown>
    suppressed: boolean
  }> = []
  const emitSuppressed: boolean[] = []
  let storedOffset = 0

  const orig = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = String(url).split("/").pop() ?? ""
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    calls.push({
      method,
      body,
      suppressed: isTracingSuppressed(context.active()),
    })
    if (method === "getUpdates") {
      const getUpdatesCalls = calls.filter(
        (c) => c.method === "getUpdates"
      ).length
      if (getUpdatesCalls === 1) {
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
      // Second loop poll: empty + abort so the loop exits; stop() then issues
      // the confirm getUpdates (storedOffset is 51 > 0 by now).
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
        emitInbound: async () => {
          emitSuppressed.push(isTracingSuppressed(context.active()))
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
    context.disable()
    contextManager.disable()
  }

  // Every getUpdates fetch ran under a suppressed context.
  const polls = calls.filter((c) => c.method === "getUpdates")
  assert.ok(polls.length >= 3) // 2 loop polls + the stop() confirm
  for (const p of polls) assert.equal(p.suppressed, true)
  // The stop() confirm (limit:1, timeout:0 — the SECOND call site) is present
  // and suppressed too.
  const confirm = polls.find((p) => p.body.limit === 1 && p.body.timeout === 0)
  assert.ok(confirm)
  assert.equal(confirm.suppressed, true)
  // Suppression is scoped to the poll fetch ONLY: deleteWebhook (one-time
  // setup, not poll transport) and inbound dispatch stay unsuppressed.
  const deleteWebhook = calls.find((c) => c.method === "deleteWebhook")
  assert.ok(deleteWebhook)
  assert.equal(deleteWebhook.suppressed, false)
  assert.deepEqual(emitSuppressed, [false])
})
