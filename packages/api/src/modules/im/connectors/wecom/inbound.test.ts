/**
 * Inbound lifecycle tests using injected deps to avoid real WSClient /
 * Redis. Specifically covers the response to the code review finding
 * "缺一个 disconnected_event/server-disconnect 生命周期测试": SDK
 * documentation makes clear that the official @wecom/aibot-node-sdk does
 * NOT auto-reconnect after `event.disconnected_event` (server-kick) —
 * it sets isManualClose=true. The WeCom connector must rebuild the
 * client itself.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import type { TransportAccountSummary } from "@synapse/shared/types"
import type { AccountStartContext } from "../types.js"
import { makeStartWecomAccount, type WecomLifecycleDeps } from "./inbound.js"
import type { WecomClient } from "./client.js"

class FakeClient extends EventEmitter {
  connectCalls = 0
  disconnectCalls = 0
  connect() {
    this.connectCalls += 1
    return this
  }
  disconnect() {
    this.disconnectCalls += 1
  }
}

function makeAccount(): TransportAccountSummary {
  return {
    id: "acct-1",
    workspaceId: "ws-1",
    transportKind: "wecom",
    accountKey: "bot-1",
    displayName: "WeCom Bot",
    ownerScope: "workspace",
    inboundActorMode: "none",
    connectionMode: "long_connection",
    status: "active",
    credentials: { botId: "bot-1", secret: "s" },
    config: {},
    metadata: {},
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  }
}

function makeCtx(
  emitted: unknown[],
  abort?: AbortController
): { ctx: AccountStartContext; abort: AbortController } {
  const controller = abort ?? new AbortController()
  const ctx: AccountStartContext = {
    account: makeAccount(),
    signal: controller.signal,
    emitInbound: async (env) => {
      emitted.push(env)
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  }
  return { ctx, abort: controller }
}

function makeRecordingDeps(opts: {
  clients: FakeClient[]
  authPlan?: Array<"ok" | "fail">
}): {
  deps: WecomLifecycleDeps
  events: {
    holderRegistrations: WecomClient[]
    holderUnregistrations: string[]
    subscribes: string[]
    unsubscribes: string[]
  }
  getClient: (i: number) => FakeClient
} {
  const events = {
    holderRegistrations: [] as WecomClient[],
    holderUnregistrations: [] as string[],
    subscribes: [] as string[],
    unsubscribes: [] as string[],
  }
  let clientIdx = 0
  let authIdx = 0
  const deps: WecomLifecycleDeps = {
    createClient: () => {
      const c = opts.clients[clientIdx]
      if (!c) throw new Error(`no fake client at index ${clientIdx}`)
      clientIdx += 1
      return c as unknown as WecomClient
    },
    waitForAuth: async () => {
      const plan = opts.authPlan?.[authIdx]
      authIdx += 1
      if (plan === "fail") {
        throw new Error("synthetic auth failure")
      }
    },
    registerHolder: (_accountId, client) => {
      events.holderRegistrations.push(client)
    },
    unregisterHolder: (accountId) => {
      events.holderUnregistrations.push(accountId)
    },
    subscribeAccountInboundChannel: async (accountId) => {
      events.subscribes.push(accountId)
    },
    unsubscribeAccountInboundChannel: async (accountId) => {
      events.unsubscribes.push(accountId)
    },
    rebuildBackoffMs: 5,
    sleep: async () => {},
  }
  return { deps, events, getClient: (i) => opts.clients[i] }
}

test("startWecomAccount: happy path → subscribe before registerHolder, returns stop", async () => {
  const client0 = new FakeClient()
  const { deps, events } = makeRecordingDeps({ clients: [client0] })
  const start = makeStartWecomAccount(deps)
  const running = await start(makeCtx([]).ctx)
  assert.equal(client0.connectCalls, 1)
  assert.equal(events.subscribes.length, 1, "subscribe was called")
  assert.equal(events.subscribes[0], "acct-1")
  assert.equal(events.holderRegistrations.length, 1)
  assert.equal(events.holderRegistrations[0], client0 as unknown as WecomClient)
  await running.stop()
  assert.equal(events.holderUnregistrations.length, 1)
  assert.equal(events.unsubscribes.length, 1)
  assert.equal(client0.disconnectCalls, 1)
})

test("startWecomAccount: auth failure → disconnect old client + throw (no orphan)", async () => {
  const client0 = new FakeClient()
  const { deps } = makeRecordingDeps({
    clients: [client0],
    authPlan: ["fail"],
  })
  const start = makeStartWecomAccount(deps)
  await assert.rejects(start(makeCtx([]).ctx), /synthetic auth failure/)
  // Critical: client.disconnect() must be called so SDK's background
  // reconnect loop doesn't keep an orphan client alive.
  assert.equal(client0.disconnectCalls, 1)
})

test("startWecomAccount: subscribe failure also disconnects client", async () => {
  const client0 = new FakeClient()
  const baseDeps = makeRecordingDeps({ clients: [client0] })
  const deps: WecomLifecycleDeps = {
    ...baseDeps.deps,
    subscribeAccountInboundChannel: async () => {
      throw new Error("redis subscribe blew up")
    },
  }
  const start = makeStartWecomAccount(deps)
  await assert.rejects(start(makeCtx([]).ctx), /subscribe blew up/)
  assert.equal(client0.disconnectCalls, 1)
})

test("event.disconnected_event triggers rebuild → new client registered", async () => {
  // Server kicks us. SDK fires `event.disconnected_event` and sets
  // isManualClose=true (verified in SDK source comment). The connector
  // must build a fresh WSClient — verify the swap.
  const client0 = new FakeClient()
  const client1 = new FakeClient()
  const { deps, events, getClient } = makeRecordingDeps({
    clients: [client0, client1],
  })
  const start = makeStartWecomAccount(deps)
  const running = await start(makeCtx([]).ctx)

  // Sanity: initial registration is client0.
  assert.equal(events.holderRegistrations.length, 1)
  assert.equal(events.holderRegistrations[0], client0 as unknown as WecomClient)

  // Server-kick: SDK emits a frame whose body.event.eventtype is "disconnected_event".
  client0.emit("event", {
    headers: { req_id: "x" },
    body: { event: { eventtype: "disconnected_event" } },
  })
  // Wait for rebuild loop to complete (with rebuildBackoffMs=5 it's quick).
  await new Promise((r) => setTimeout(r, 30))

  // Verify the rebuild sequence:
  //   1. unregisterHolder("acct-1") — fast-fail in-flight dispatches
  //   2. client0.disconnect() — stop dead SDK client cleanly
  //   3. createClient() again → client1
  //   4. client1.connect() + waitForAuth ok
  //   5. registerHolder(client1) — outbound dispatches resume on new client
  assert.equal(events.holderUnregistrations.length, 1)
  assert.equal(client0.disconnectCalls, 1)
  assert.equal(getClient(1).connectCalls, 1)
  assert.equal(events.holderRegistrations.length, 2)
  assert.equal(events.holderRegistrations[1], client1 as unknown as WecomClient)

  // Tear down. The second client (currently held) is disconnected.
  await running.stop()
  assert.equal(getClient(1).disconnectCalls, 1)
})

test("rebuild retries on auth failure then succeeds", async () => {
  // First rebuild attempt fails auth; second succeeds. Verifies the
  // retry loop honors the backoff and ultimately recovers.
  const client0 = new FakeClient()
  const client1 = new FakeClient()
  const client2 = new FakeClient()
  const { deps, events } = makeRecordingDeps({
    clients: [client0, client1, client2],
    authPlan: ["ok", "fail", "ok"],
  })
  const start = makeStartWecomAccount(deps)
  const running = await start(makeCtx([]).ctx)

  client0.emit("event", {
    headers: {},
    body: { event: { eventtype: "disconnected_event" } },
  })
  // Allow time for: fail attempt → 5ms backoff → success attempt
  await new Promise((r) => setTimeout(r, 60))

  // First rebuild attempt produced a client1 that failed auth + got disconnected.
  assert.equal(
    client1.disconnectCalls,
    1,
    "client1 disconnected after auth failure"
  )
  // Second rebuild attempt produced client2 which auth'd ok.
  assert.equal(client2.connectCalls, 1)
  assert.equal(events.holderRegistrations.length, 2)
  assert.equal(events.holderRegistrations[1], client2 as unknown as WecomClient)
  await running.stop()
})

test("rebuild does not re-enter while one is already in flight", async () => {
  // Two disconnected_event frames in quick succession should NOT spawn
  // two rebuild loops. The `rebuildPromise !== null` guard keeps them
  // serialized.
  const client0 = new FakeClient()
  const client1 = new FakeClient()
  const { deps, events } = makeRecordingDeps({
    clients: [client0, client1],
  })
  const start = makeStartWecomAccount(deps)
  const running = await start(makeCtx([]).ctx)

  // Emit twice in rapid succession before the first rebuild completes.
  client0.emit("event", {
    headers: {},
    body: { event: { eventtype: "disconnected_event" } },
  })
  client0.emit("event", {
    headers: {},
    body: { event: { eventtype: "disconnected_event" } },
  })
  await new Promise((r) => setTimeout(r, 30))

  // Only one rebuild ran → client1 is the only newly-registered holder.
  assert.equal(events.holderRegistrations.length, 2, "exactly one rebuild")
  await running.stop()
})

test("stop() during rebuild cancels the loop", async () => {
  // Hold the second auth attempt forever via a manually-controlled
  // promise, so we deterministically test the case where stop() is
  // called while a rebuild attempt is in flight (rather than racing
  // a tight auth-failure loop).
  const client0 = new FakeClient()
  const client1 = new FakeClient()
  let releaseAuth: (() => void) | undefined
  const authBlocker = new Promise<void>((resolve) => {
    releaseAuth = resolve
  })
  let authCallNo = 0
  const deps: WecomLifecycleDeps = {
    createClient: () => {
      const c = authCallNo === 0 ? client0 : client1
      return c as unknown as WecomClient
    },
    waitForAuth: async () => {
      authCallNo += 1
      if (authCallNo === 1) return // initial success
      // Second call (rebuild) hangs until releaseAuth() is called
      await authBlocker
    },
    registerHolder: () => {},
    unregisterHolder: () => {},
    subscribeAccountInboundChannel: async () => {},
    unsubscribeAccountInboundChannel: async () => {},
    rebuildBackoffMs: 5,
    sleep: async () => {},
  }
  const start = makeStartWecomAccount(deps)
  const running = await start(makeCtx([]).ctx)
  client0.emit("event", {
    headers: {},
    body: { event: { eventtype: "disconnected_event" } },
  })
  await new Promise((r) => setTimeout(r, 5))
  // Rebuild is now blocked waiting on authBlocker. stop() must NOT
  // hang waiting for it to complete — it sets stopped=true and then
  // when we release the auth, the next loop iteration sees stopped=true
  // and bails.
  const stopPromise = running.stop()
  // Now release the auth so the rebuild loop unblocks; it should see
  // stopped=true and exit, allowing stopPromise to resolve.
  releaseAuth?.()
  const stopWithTimeout = Promise.race([
    stopPromise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("stop() did not return within 500ms")),
        500
      )
    ),
  ])
  await stopWithTimeout
})

test("'event' frames that are NOT disconnected_event do not trigger rebuild", async () => {
  const client0 = new FakeClient()
  const { deps, events } = makeRecordingDeps({ clients: [client0] })
  const start = makeStartWecomAccount(deps)
  const running = await start(makeCtx([]).ctx)
  client0.emit("event", {
    headers: {},
    body: { event: { eventtype: "enter_chat" } },
  })
  client0.emit("event", {
    headers: {},
    body: { event: { eventtype: "template_card_event" } },
  })
  await new Promise((r) => setTimeout(r, 10))
  // No rebuild ⇒ only one holder registration total.
  assert.equal(events.holderRegistrations.length, 1)
  await running.stop()
})

test("'message' frames are normalized and emitted via ctx.emitInbound", async () => {
  const client0 = new FakeClient()
  const { deps } = makeRecordingDeps({ clients: [client0] })
  const start = makeStartWecomAccount(deps)
  const emitted: unknown[] = []
  const running = await start(makeCtx(emitted).ctx)
  client0.emit("message", {
    headers: { req_id: "r-1" },
    body: {
      msgid: "m-1",
      chattype: "single",
      from: { userid: "u-1" },
      msgtype: "text",
      text: { content: "hello from wecom" },
    },
  })
  // emit + ingest is microtask-async via ctx.emitInbound
  await new Promise((r) => setImmediate(r))
  assert.equal(emitted.length, 1)
  const env = emitted[0] as {
    externalMessageId: string
    sender: { externalId: string }
  }
  assert.equal(env.externalMessageId, "m-1")
  assert.equal(env.sender.externalId, "u-1")
  await running.stop()
})

// ─── Cancellable rebuild + stale-client-guard coverage ───
//
// Added in response to code review:
//   - Medium: rebuild waitForAuth/backoff not cancellable → stop() hangs
//     up to AUTH_TIMEOUT_MS + backoffMs
//   - Medium: old client's listeners can re-fire disconnected_event after
//     rebuild registered new holder, triggering a duplicate rebuild

test("stop() aborts ctx.signal so a blocked auth wait unblocks immediately", async () => {
  // The rebuild attempt's auth wait is a real waitForAuthenticated-style
  // wait that respects ctx.signal. Without the abort plumbing, stop()
  // would wait up to AUTH_TIMEOUT_MS for the wait to time out.
  const client0 = new FakeClient()
  const client1 = new FakeClient()
  let authIdx = 0
  let observedSignal: AbortSignal | undefined
  const deps: WecomLifecycleDeps = {
    createClient: () =>
      (authIdx === 0 ? client0 : client1) as unknown as WecomClient,
    waitForAuth: async (_client, _timeoutMs, signal) => {
      authIdx += 1
      if (authIdx === 1) return // initial start
      // Rebuild: hang on signal — abort produces a rejection.
      observedSignal = signal
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(new Error("wecom auth aborted"))
        if (signal?.aborted) {
          onAbort()
          return
        }
        signal?.addEventListener("abort", onAbort, { once: true })
      })
    },
    registerHolder: () => {},
    unregisterHolder: () => {},
    subscribeAccountInboundChannel: async () => {},
    unsubscribeAccountInboundChannel: async () => {},
    rebuildBackoffMs: 5,
    sleep: async (ms, signal) => {
      // Cancellable sleep — production uses node:timers/promises#delay
      // with { signal }. Mirror that semantics here.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms)
        const onAbort = () => {
          clearTimeout(timer)
          reject(new Error("aborted"))
        }
        if (signal?.aborted) {
          clearTimeout(timer)
          onAbort()
          return
        }
        signal?.addEventListener("abort", onAbort, { once: true })
      })
    },
  }
  const start = makeStartWecomAccount(deps)
  const { ctx, abort } = makeCtx([])
  const running = await start(ctx)
  client0.emit("event", {
    headers: {},
    body: { event: { eventtype: "disconnected_event" } },
  })
  // Let the rebuild loop reach the waitForAuth() call.
  await new Promise((r) => setTimeout(r, 5))
  assert.ok(observedSignal, "rebuild reached waitForAuth with a signal")

  // Production: runtime.ts aborts BEFORE calling our stop(). Mirror that.
  abort.abort()
  // stop() must return promptly (well under AUTH_TIMEOUT_MS=30000ms).
  const stopWithBudget = Promise.race([
    running.stop(),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("stop() did not return within 500ms")),
        500
      )
    ),
  ])
  await stopWithBudget
})

test("stop() aborts ctx.signal so backoff sleep unblocks immediately", async () => {
  // Rebuild loop sleeps after a failed attempt. Without cancellable
  // sleep, stop() waits up to backoffMs (production default 30s) before
  // the loop can notice `stopped=true`.
  const client0 = new FakeClient()
  const client1 = new FakeClient()
  let authIdx = 0
  let sleeping = false
  let sleepSignal: AbortSignal | undefined
  const deps: WecomLifecycleDeps = {
    createClient: () =>
      (authIdx === 0 ? client0 : client1) as unknown as WecomClient,
    waitForAuth: async () => {
      authIdx += 1
      if (authIdx === 1) return
      throw new Error("synthetic rebuild auth fail")
    },
    registerHolder: () => {},
    unregisterHolder: () => {},
    subscribeAccountInboundChannel: async () => {},
    unsubscribeAccountInboundChannel: async () => {},
    // A long backoff that we expect to be interrupted by ctx.signal.
    rebuildBackoffMs: 60_000,
    sleep: async (ms, signal) => {
      sleeping = true
      sleepSignal = signal
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms)
        const onAbort = () => {
          clearTimeout(timer)
          reject(new Error("aborted"))
        }
        if (signal?.aborted) {
          clearTimeout(timer)
          onAbort()
          return
        }
        signal?.addEventListener("abort", onAbort, { once: true })
      })
    },
  }
  const start = makeStartWecomAccount(deps)
  const { ctx, abort } = makeCtx([])
  const running = await start(ctx)
  client0.emit("event", {
    headers: {},
    body: { event: { eventtype: "disconnected_event" } },
  })
  // Let attempt fail and loop enter the backoff sleep.
  await new Promise((r) => setTimeout(r, 10))
  assert.ok(sleeping, "rebuild loop entered backoff sleep")
  assert.ok(sleepSignal, "sleep received the abort signal")

  abort.abort()
  await Promise.race([
    running.stop(),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("stop() did not return within 500ms")),
        500
      )
    ),
  ])
})

test("stale old-client emitting disconnected_event after rebuild does NOT unregister new holder", async () => {
  // Defensive guard for: queued / replayed disconnected_event from the
  // OLD WSClient instance fires AFTER the rebuild has completed and the
  // NEW client is registered. Without the `client === currentClient`
  // check in the event listener closure, the stale event would trigger
  // ANOTHER rebuild loop that unregisters the (currently healthy)
  // freshly-registered holder.
  const client0 = new FakeClient()
  const client1 = new FakeClient()
  const client2 = new FakeClient() // would be picked up by a 2nd rebuild
  const { deps, events } = makeRecordingDeps({
    clients: [client0, client1, client2],
  })
  const start = makeStartWecomAccount(deps)
  const running = await start(makeCtx([]).ctx)

  // First rebuild: server kicks client0 → connector swaps to client1.
  client0.emit("event", {
    headers: {},
    body: { event: { eventtype: "disconnected_event" } },
  })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(events.holderRegistrations.length, 2, "rebuild produced client1")

  // Snapshot state BEFORE the stale emit.
  const unregsBefore = events.holderUnregistrations.length
  const regsBefore = events.holderRegistrations.length
  const client1DisconnectsBefore = client1.disconnectCalls

  // Now the OLD client0 emits a queued / replayed disconnected_event.
  // The guard MUST drop this and not start another rebuild.
  client0.emit("event", {
    headers: {},
    body: { event: { eventtype: "disconnected_event" } },
  })
  await new Promise((r) => setTimeout(r, 30))

  assert.equal(
    events.holderUnregistrations.length,
    unregsBefore,
    "no extra unregisterHolder triggered by stale client"
  )
  assert.equal(
    events.holderRegistrations.length,
    regsBefore,
    "no extra registerHolder (i.e. client1 still the active holder)"
  )
  assert.equal(
    client1.disconnectCalls,
    client1DisconnectsBefore,
    "client1 (current holder) was not torn down"
  )
  assert.equal(
    client2.connectCalls,
    0,
    "no second rebuild attempt → client2 never used"
  )

  await running.stop()
})

test("stale old-client emitting 'message' after rebuild is dropped (not double-ingested)", async () => {
  // Similar guard for inbound messages. If the OLD client emits a
  // queued message after rebuild swapped it out, the guard drops it
  // (the new client receives its own copy from the WeCom server, with
  // upstream dedupe by msgid in ingest.ts).
  const client0 = new FakeClient()
  const client1 = new FakeClient()
  const { deps } = makeRecordingDeps({ clients: [client0, client1] })
  const start = makeStartWecomAccount(deps)
  const emitted: unknown[] = []
  const running = await start(makeCtx(emitted).ctx)

  // Rebuild
  client0.emit("event", {
    headers: {},
    body: { event: { eventtype: "disconnected_event" } },
  })
  await new Promise((r) => setTimeout(r, 30))

  // Sanity: client1 is the active holder now. Emit a message from old.
  client0.emit("message", {
    headers: { req_id: "r-stale" },
    body: {
      msgid: "m-stale",
      chattype: "single",
      from: { userid: "u" },
      msgtype: "text",
      text: { content: "from dead client" },
    },
  })
  await new Promise((r) => setImmediate(r))
  assert.equal(emitted.length, 0, "stale message dropped by isActive() guard")

  // And the live client1's messages still flow through.
  client1.emit("message", {
    headers: { req_id: "r-live" },
    body: {
      msgid: "m-live",
      chattype: "single",
      from: { userid: "u" },
      msgtype: "text",
      text: { content: "from live client" },
    },
  })
  await new Promise((r) => setImmediate(r))
  assert.equal(emitted.length, 1)
  await running.stop()
})
