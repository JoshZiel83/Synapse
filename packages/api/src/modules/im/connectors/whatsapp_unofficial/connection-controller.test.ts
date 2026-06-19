import test from "node:test"
import assert from "node:assert/strict"
import { DisconnectReason } from "baileys"
import type { TransportAccountSummary } from "@synapse/shared/types"
import type { AccountStartContext, InboundEnvelope } from "../types.js"
import { buildManagedAuthState } from "./auth-state.js"
import { freshAuthSnapshot, type AuthSnapshot } from "./creds-persistence.js"
import { startWhatsappAccount } from "./connection-controller.js"
import { __resetHandlesForTest, getHandle } from "./running-registry.js"
import { setRedisForTest, type SessionGuardRedis } from "./session-guard.js"

// ── in-memory redis for the session-guard ─────────────────────────
class FakeRedis implements SessionGuardRedis {
  store = new Map<string, { value: string; expiresAtMs: number }>()
  async set(k: string, v: string, _m: "EX", s: number) {
    this.store.set(k, { value: v, expiresAtMs: Date.now() + s * 1000 })
    return "OK"
  }
  async get(k: string) {
    return this.store.get(k)?.value ?? null
  }
  async del(k: string) {
    return this.store.delete(k) ? 1 : 0
  }
  async ttl(k: string) {
    const e = this.store.get(k)
    return e ? Math.ceil((e.expiresAtMs - Date.now()) / 1000) : -2
  }
  async exists(k: string) {
    return this.store.has(k) ? 1 : 0
  }
}

// ── controllable mock socket ──────────────────────────────────────
type Listener = (arg: unknown) => void
function makeMockSocket(snapshot: AuthSnapshot) {
  const managedAuth = buildManagedAuthState(snapshot)
  const listeners = new Map<string, Listener[]>()
  const ended = { count: 0 }
  const socket = {
    ev: {
      on(event: string, cb: Listener) {
        const arr = listeners.get(event) ?? []
        arr.push(cb)
        listeners.set(event, arr)
      },
    },
    end() {
      ended.count += 1
    },
    async logout() {},
    sendMessage: async () => ({ key: { id: "x" } }),
  }
  function emit(event: string, arg: unknown) {
    for (const cb of listeners.get(event) ?? []) cb(arg)
  }
  return { socket, managedAuth, emit, ended }
}

function account(): TransportAccountSummary {
  return {
    id: "acc-cc",
    workspaceId: "ws1",
    transportKind: "whatsapp_unofficial",
    accountKey: "k",
    displayName: "WA",
    ownerScope: "workspace",
    inboundActorMode: "none",
    connectionMode: "long_connection",
    status: "active",
    config: {},
    metadata: {},
    createdAt: "2024-01-01T00:00:00.000Z" as never,
    updatedAt: "2024-01-01T00:00:00.000Z" as never,
  }
}

function makeCtx(emitted: InboundEnvelope[]): {
  ctx: AccountStartContext
  abort: () => void
} {
  const controller = new AbortController()
  const ctx: AccountStartContext = {
    account: account(),
    signal: controller.signal,
    emitInbound: async (e) => {
      emitted.push(e)
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  }
  return { ctx, abort: () => controller.abort() }
}

function tick(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

test("persists snapshot on creds.update and on key changes", async () => {
  __resetHandlesForTest()
  const restore = setRedisForTest(new FakeRedis())
  const persisted: AuthSnapshot[] = []
  const emitted: InboundEnvelope[] = []
  const { ctx, abort } = makeCtx(emitted)

  const box: { current: ReturnType<typeof makeMockSocket> | null } = {
    current: null,
  }
  const running = await startWhatsappAccount(ctx, {
    minStableMs: 0,
    persist: (async (p: { snapshot: AuthSnapshot }) => {
      persisted.push(p.snapshot)
    }) as never,
    wipe: (async () => {}) as never,
    socketFactory: ((snap: AuthSnapshot) => {
      box.current = makeMockSocket(snap)
      return box.current as never
    }) as never,
  })

  await tick()
  assert.ok(box.current)
  box.current!.emit("connection.update", { connection: "open" })
  box.current!.emit("creds.update", {})
  box.current!.managedAuth.state.keys.set({
    session: { s1: new Uint8Array([1]) },
  })
  await tick()

  assert.ok(persisted.length >= 2, "creds.update + key change both persist")

  abort()
  box.current!.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: undefined, date: new Date() },
  })
  await running.stop()
  restore()
})

test("registers a live handle and marks connected on open", async () => {
  __resetHandlesForTest()
  const restore = setRedisForTest(new FakeRedis())
  const emitted: InboundEnvelope[] = []
  const { ctx, abort } = makeCtx(emitted)
  const box: { current: ReturnType<typeof makeMockSocket> | null } = {
    current: null,
  }

  const running = await startWhatsappAccount(ctx, {
    minStableMs: 0,
    persist: (async () => {}) as never,
    wipe: (async () => {}) as never,
    socketFactory: ((snap: AuthSnapshot) => {
      box.current = makeMockSocket(snap)
      return box.current as never
    }) as never,
  })

  await tick()
  assert.ok(getHandle("acc-cc"))
  assert.equal(getHandle("acc-cc")?.connected, false)
  box.current!.emit("connection.update", { connection: "open" })
  await tick()
  assert.equal(getHandle("acc-cc")?.connected, true)

  abort()
  box.current!.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: undefined, date: new Date() },
  })
  await running.stop()
  assert.equal(getHandle("acc-cc"), undefined, "handle unregistered on stop")
  restore()
})

test("loggedOut (401) → wipes creds + sets the session-guard pause flag", async () => {
  __resetHandlesForTest()
  const fake = new FakeRedis()
  const restore = setRedisForTest(fake)
  let wiped = false
  const emitted: InboundEnvelope[] = []
  const { ctx, abort } = makeCtx(emitted)
  const box: { current: ReturnType<typeof makeMockSocket> | null } = {
    current: null,
  }

  const running = await startWhatsappAccount(ctx, {
    minStableMs: 0,
    persist: (async () => {}) as never,
    wipe: (async () => {
      wiped = true
    }) as never,
    socketFactory: ((snap: AuthSnapshot) => {
      box.current = makeMockSocket(snap)
      return box.current as never
    }) as never,
  })

  await tick()
  box.current!.emit("connection.update", {
    connection: "close",
    lastDisconnect: {
      error: { output: { statusCode: DisconnectReason.loggedOut } },
      date: new Date(),
    },
  })
  await tick(50)

  assert.ok(wiped, "creds wiped on loggedOut")
  assert.equal(
    await fake.exists("im:whatsapp_unofficial:session-paused:acc-cc"),
    1
  )

  abort()
  await running.stop()
  restore()
})

test("a transient reconnect reuses the live snapshot (no stale-creds reload)", async () => {
  __resetHandlesForTest()
  const restore = setRedisForTest(new FakeRedis())
  const emitted: InboundEnvelope[] = []
  const { ctx, abort } = makeCtx(emitted)
  const snapshotsSeen: AuthSnapshot[] = []
  const box: { current: ReturnType<typeof makeMockSocket> | null } = {
    current: null,
  }

  const running = await startWhatsappAccount(ctx, {
    minStableMs: 0,
    persist: (async () => {}) as never,
    wipe: (async () => {}) as never,
    socketFactory: ((snap: AuthSnapshot) => {
      snapshotsSeen.push(snap)
      box.current = makeMockSocket(snap)
      return box.current as never
    }) as never,
  })

  await tick()
  // Mutate creds on the first cycle (simulates pairing landing).
  box.current!.managedAuth.getSnapshot().creds.registered = true
  // Transient close → reconnect (undefined error → reconnect action).
  box.current!.emit("connection.update", {
    connection: "close",
    lastDisconnect: {
      error: { output: { statusCode: 428 } },
      date: new Date(),
    },
  })
  // The reconnect path backs off (1s base + up to 1s jitter) before reconnecting.
  await tick(2300)

  assert.ok(snapshotsSeen.length >= 2, "a second connect cycle ran")
  // The second cycle reused the SAME snapshot object the first cycle mutated.
  assert.equal(snapshotsSeen[1].creds.registered, true)

  abort()
  box.current!.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: undefined, date: new Date() },
  })
  await running.stop()
  restore()
})

test("messages.upsert (notify) is normalized + emitted", async () => {
  __resetHandlesForTest()
  const restore = setRedisForTest(new FakeRedis())
  const emitted: InboundEnvelope[] = []
  const { ctx, abort } = makeCtx(emitted)
  const box: { current: ReturnType<typeof makeMockSocket> | null } = {
    current: null,
  }

  const running = await startWhatsappAccount(ctx, {
    minStableMs: 0,
    persist: (async () => {}) as never,
    wipe: (async () => {}) as never,
    downloadMedia: async () => Buffer.from(""),
    socketFactory: ((snap: AuthSnapshot) => {
      box.current = makeMockSocket(snap)
      return box.current as never
    }) as never,
  })

  await tick()
  box.current!.emit("connection.update", { connection: "open" })
  box.current!.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: {
          id: "UP1",
          remoteJid: "15551234567@s.whatsapp.net",
          fromMe: false,
        },
        messageTimestamp: 1_700_000_000,
        message: { conversation: "ping" },
      },
    ],
  })
  await tick()

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].externalMessageId, "UP1")

  // a non-notify batch is ignored
  box.current!.emit("messages.upsert", {
    type: "append",
    messages: [
      {
        key: {
          id: "UP2",
          remoteJid: "15551234567@s.whatsapp.net",
          fromMe: false,
        },
        message: { conversation: "ignored" },
      },
    ],
  })
  await tick()
  assert.equal(emitted.length, 1)

  abort()
  box.current!.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: undefined, date: new Date() },
  })
  await running.stop()
  restore()
})

test("operator pause on an OPEN socket tears the live connection down (WU-5)", async () => {
  __resetHandlesForTest()
  const fake = new FakeRedis()
  const restore = setRedisForTest(fake)
  const emitted: InboundEnvelope[] = []
  const { ctx, abort } = makeCtx(emitted)
  const box: { current: ReturnType<typeof makeMockSocket> | null } = {
    current: null,
  }

  const running = await startWhatsappAccount(ctx, {
    minStableMs: 0,
    pauseWatchIntervalMs: 10, // fast watcher for the test
    persist: (async () => {}) as never,
    wipe: (async () => {}) as never,
    socketFactory: ((snap: AuthSnapshot) => {
      box.current = makeMockSocket(snap)
      return box.current as never
    }) as never,
  })

  await tick()
  box.current!.emit("connection.update", { connection: "open" })
  await tick()
  assert.equal(getHandle("acc-cc")?.connected, true)
  const endsBefore = box.current!.ended.count

  // An operator engages the kill-switch while the socket is OPEN.
  await fake.set(
    "im:whatsapp_unofficial:session-paused:acc-cc",
    JSON.stringify({ reason: "operator", at: Date.now() }),
    "EX",
    3600
  )
  // The pause watcher must proactively end() the live socket.
  await tick(60)
  assert.ok(
    box.current!.ended.count > endsBefore,
    "the live socket was torn down on operator pause"
  )

  abort()
  await running.stop()
  restore()
})

test("on open, an OPERATOR pause is NOT auto-cleared (WU-9)", async () => {
  __resetHandlesForTest()
  const fake = new FakeRedis()
  const restore = setRedisForTest(fake)
  const emitted: InboundEnvelope[] = []
  const { ctx, abort } = makeCtx(emitted)
  const box: { current: ReturnType<typeof makeMockSocket> | null } = {
    current: null,
  }

  const running = await startWhatsappAccount(ctx, {
    minStableMs: 0,
    pauseWatchIntervalMs: 100_000, // disable the watcher for this assertion
    persist: (async () => {}) as never,
    wipe: (async () => {}) as never,
    socketFactory: ((snap: AuthSnapshot) => {
      box.current = makeMockSocket(snap)
      return box.current as never
    }) as never,
  })

  await tick()
  // An operator pause is set DURING the in-flight connect cycle.
  await fake.set(
    "im:whatsapp_unofficial:session-paused:acc-cc",
    JSON.stringify({ reason: "operator", at: Date.now() }),
    "EX",
    3600
  )
  box.current!.emit("connection.update", { connection: "open" })
  await tick(30)

  assert.equal(
    await fake.exists("im:whatsapp_unofficial:session-paused:acc-cc"),
    1,
    "operator pause must survive a reconnect/open"
  )

  abort()
  box.current!.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: undefined, date: new Date() },
  })
  await running.stop()
  restore()
})

test("on open, an AUTO pause IS auto-cleared", async () => {
  __resetHandlesForTest()
  const fake = new FakeRedis()
  const restore = setRedisForTest(fake)
  const emitted: InboundEnvelope[] = []
  const { ctx, abort } = makeCtx(emitted)
  const box: { current: ReturnType<typeof makeMockSocket> | null } = {
    current: null,
  }

  const running = await startWhatsappAccount(ctx, {
    minStableMs: 0,
    pauseWatchIntervalMs: 100_000,
    persist: (async () => {}) as never,
    wipe: (async () => {}) as never,
    socketFactory: ((snap: AuthSnapshot) => {
      box.current = makeMockSocket(snap)
      return box.current as never
    }) as never,
  })

  await tick()
  await fake.set(
    "im:whatsapp_unofficial:session-paused:acc-cc",
    JSON.stringify({ reason: "logged_out", at: Date.now() }),
    "EX",
    3600
  )
  box.current!.emit("connection.update", { connection: "open" })
  await tick(30)

  assert.equal(
    await fake.exists("im:whatsapp_unofficial:session-paused:acc-cc"),
    0,
    "auto (logged_out) pause is cleared on a successful open"
  )

  abort()
  box.current!.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: undefined, date: new Date() },
  })
  await running.stop()
  restore()
})

test("wipe (loggedOut) sets the pause BEFORE the loop can re-enter connectOnce (WU-10/#22)", async () => {
  __resetHandlesForTest()
  // A redis whose SET resolves on a later microtask turn — this is where the
  // old fire-and-forget pauseSession lost the race to runLoop's pause check.
  class SlowSetRedis extends FakeRedis {
    override async set(k: string, v: string, m: "EX", s: number) {
      await Promise.resolve()
      await Promise.resolve()
      return super.set(k, v, m, s)
    }
  }
  const fake = new SlowSetRedis()
  const restore = setRedisForTest(fake)
  const emitted: InboundEnvelope[] = []
  const { ctx, abort } = makeCtx(emitted)
  let factoryCalls = 0
  const box: { current: ReturnType<typeof makeMockSocket> | null } = {
    current: null,
  }

  const running = await startWhatsappAccount(ctx, {
    minStableMs: 0,
    persist: (async () => {}) as never,
    wipe: (async () => {}) as never,
    socketFactory: ((snap: AuthSnapshot) => {
      factoryCalls += 1
      box.current = makeMockSocket(snap)
      return box.current as never
    }) as never,
  })

  await tick()
  assert.equal(factoryCalls, 1, "one connect cycle so far")
  box.current!.emit("connection.update", {
    connection: "close",
    lastDisconnect: {
      error: { output: { statusCode: DisconnectReason.loggedOut } },
      date: new Date(),
    },
  })
  // Give the loop several turns to (incorrectly) re-enter connectOnce.
  await tick(80)

  assert.equal(
    factoryCalls,
    1,
    "no second connect cycle — the pause landed before runLoop re-checked"
  )
  assert.equal(
    await fake.exists("im:whatsapp_unofficial:session-paused:acc-cc"),
    1
  )

  abort()
  await running.stop()
  restore()
})
