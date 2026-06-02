import { test } from "node:test"
import assert from "node:assert/strict"

import {
  createChatSocket,
  type ChatSocketAuth,
  type ChatSocketSubscription,
  type SocketLike,
} from "./index.js"

/** A controllable fake socket + timer harness for deterministic tests. */
function makeHarness(opts: {
  auth: ChatSocketAuth | null
  subscriptions: ChatSocketSubscription[]
  authErrorIsFatal?: boolean
}) {
  const sent: Array<Record<string, unknown>> = []
  const events: Array<Record<string, unknown>> = []
  const connectedCalls: number[] = []
  const states: string[] = []
  let sockets: FakeSocket[] = []
  let connectCount = 0

  type Timer = { id: number; fn: () => void; ms: number }
  let timerSeq = 0
  const timers = new Map<number, Timer>()

  class FakeSocket implements SocketLike {
    onopen: ((event?: unknown) => void) | null = null
    onmessage: ((event: { data: unknown }) => void) | null = null
    onclose: ((event?: unknown) => void) | null = null
    onerror: ((event?: unknown) => void) | null = null
    closed = false
    send(data: string) {
      sent.push(JSON.parse(data))
    }
    close() {
      this.closed = true
      this.onclose?.()
    }
    // test helpers
    open() {
      this.onopen?.()
    }
    receive(frame: Record<string, unknown>) {
      this.onmessage?.({ data: JSON.stringify(frame) })
    }
  }

  let auth = opts.auth
  let subscriptions = opts.subscriptions

  const handle = createChatSocket({
    connect: () => {
      connectCount += 1
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
    resolveUrl: () => "ws://test/ws",
    setTimer: (fn, ms) => {
      const id = ++timerSeq
      timers.set(id, { id, fn, ms })
      return id
    },
    clearTimer: (h) => {
      timers.delete(h as number)
    },
    getAuth: () => auth,
    getSubscriptions: () => subscriptions,
    onEvent: (e) => events.push(e),
    onConnected: () => connectedCalls.push(connectedCalls.length),
    onStateChange: (s) => states.push(s),
    authErrorIsFatal: opts.authErrorIsFatal,
  })

  return {
    handle,
    sent,
    events,
    connectedCalls,
    states,
    get sockets() {
      return sockets
    },
    last() {
      return sockets[sockets.length - 1]!
    },
    get connectCount() {
      return connectCount
    },
    setAuth(a: ChatSocketAuth | null) {
      auth = a
    },
    setSubscriptions(s: ChatSocketSubscription[]) {
      subscriptions = s
    },
    /** Fire all pending timers (e.g. reconnect/ping) once. */
    flushTimers() {
      const pending = [...timers.values()]
      timers.clear()
      for (const t of pending) t.fn()
    },
    pendingTimerCount() {
      return timers.size
    },
  }
}

test("start connects, sends auth, and on auth.ok flushes subscriptions + onConnected", () => {
  const h = makeHarness({
    auth: { token: "t1", workspaceId: "ws1" },
    subscriptions: [{ key: "inbox", topic: "inbox" }],
  })
  h.handle.start()
  assert.equal(h.connectCount, 1)
  h.last().open()
  assert.deepEqual(h.sent[0], { type: "auth", token: "t1", workspaceId: "ws1" })

  h.last().receive({ type: "auth.ok" })
  assert.equal(h.connectedCalls.length, 1)
  // subscription frame sent after auth
  assert.deepEqual(h.sent[1], {
    type: "subscribe",
    key: "inbox",
    topic: "inbox",
  })
  assert.ok(h.states.includes("open"))
})

test("does not connect when auth has no workspaceId", () => {
  const h = makeHarness({ auth: { token: "t1" }, subscriptions: [] })
  h.handle.start()
  assert.equal(h.connectCount, 0)
})

test("ping is answered with pong", () => {
  const h = makeHarness({
    auth: { workspaceId: "ws1" },
    subscriptions: [],
  })
  h.handle.start()
  h.last().open()
  h.last().receive({ type: "auth.ok" })
  const before = h.sent.length
  h.last().receive({ type: "ping" })
  assert.deepEqual(h.sent[before], { type: "pong" })
})

test("non-protocol frames are delivered to onEvent", () => {
  const h = makeHarness({ auth: { workspaceId: "ws1" }, subscriptions: [] })
  h.handle.start()
  h.last().open()
  h.last().receive({ type: "auth.ok" })
  h.last().receive({ type: "conversation.item.created", payload: { x: 1 } })
  assert.equal(h.events.length, 1)
  assert.equal(h.events[0]!.type, "conversation.item.created")
})

test("unexpected close schedules a reconnect (one socket per attempt)", () => {
  const h = makeHarness({ auth: { workspaceId: "ws1" }, subscriptions: [] })
  h.handle.start()
  h.last().open()
  h.last().receive({ type: "auth.ok" })
  assert.equal(h.connectCount, 1)

  // server drops the connection
  h.last().onclose?.()
  assert.equal(h.pendingTimerCount() >= 1, true)
  h.flushTimers()
  assert.equal(h.connectCount, 2) // reconnected
})

test("auth.error tears down without reconnecting", () => {
  const h = makeHarness({ auth: { workspaceId: "ws1" }, subscriptions: [] })
  h.handle.start()
  h.last().open()
  h.last().receive({ type: "auth.error" })
  assert.equal(h.pendingTimerCount(), 0)
  // no further sockets created on flush
  h.flushTimers()
  assert.equal(h.connectCount, 1)
})

test("auth.error does NOT reconnect the same identity on a later sync()", () => {
  const h = makeHarness({
    auth: { token: "t1", workspaceId: "ws1" },
    subscriptions: [{ key: "inbox", topic: "inbox" }],
  })
  h.handle.start()
  h.last().open()
  h.last().receive({ type: "auth.error" })
  assert.equal(h.connectCount, 1)

  // A subscription change drives sync() — must NOT reconnect the rejected identity.
  h.setSubscriptions([
    { key: "inbox", topic: "inbox" },
    { key: "c:1", topic: "conversation", conversationId: "1" },
  ])
  h.handle.sync()
  h.handle.sync()
  assert.equal(h.connectCount, 1, "rejected identity must not reconnect")

  // A NEW identity clears the fatal mark and connects.
  h.setAuth({ token: "t2", workspaceId: "ws1" })
  h.handle.sync()
  assert.equal(h.connectCount, 2, "new identity should connect")
})

test("non-fatal auth.error (cookie auth): a later sync() retries the SAME identity", () => {
  // authErrorIsFatal=false models web cookie auth (identity = workspaceId only).
  const h = makeHarness({
    auth: { workspaceId: "ws1" },
    subscriptions: [{ key: "inbox", topic: "inbox" }],
    authErrorIsFatal: false,
  })
  h.handle.start()
  h.last().open()
  h.last().receive({ type: "auth.error" })
  assert.equal(h.connectCount, 1)
  assert.equal(h.pendingTimerCount(), 0, "auth.error suspends auto-reconnect")

  // The cookie refreshed; the same workspace's socket should reconnect on sync().
  h.handle.sync()
  assert.equal(
    h.connectCount,
    2,
    "non-fatal auth.error must allow same-identity reconnect via sync()"
  )
})

test("subscription diff: adds new, removes stale, leaves unchanged", () => {
  const h = makeHarness({
    auth: { workspaceId: "ws1" },
    subscriptions: [{ key: "inbox", topic: "inbox" }],
  })
  h.handle.start()
  h.last().open()
  h.last().receive({ type: "auth.ok" })
  const baseline = h.sent.length

  // add a conversation subscription, keep inbox
  h.setSubscriptions([
    { key: "inbox", topic: "inbox" },
    { key: "c:1", topic: "conversation", conversationId: "1" },
  ])
  h.handle.sync()
  assert.deepEqual(h.sent[baseline], {
    type: "subscribe",
    key: "c:1",
    topic: "conversation",
    conversationId: "1",
  })

  // drop the conversation subscription
  h.setSubscriptions([{ key: "inbox", topic: "inbox" }])
  h.handle.sync()
  assert.deepEqual(h.sent[h.sent.length - 1], {
    type: "unsubscribe",
    key: "c:1",
  })
})

test("stop tears down and prevents reconnect", () => {
  const h = makeHarness({ auth: { workspaceId: "ws1" }, subscriptions: [] })
  h.handle.start()
  h.last().open()
  h.last().receive({ type: "auth.ok" })
  h.handle.stop()
  assert.equal(h.last().closed, true)
  assert.equal(h.pendingTimerCount(), 0)
})

test("auth identity change reconnects with the new identity", () => {
  const h = makeHarness({
    auth: { token: "t1", workspaceId: "ws1" },
    subscriptions: [],
  })
  h.handle.start()
  h.last().open()
  h.last().receive({ type: "auth.ok" })
  assert.equal(h.connectCount, 1)

  h.setAuth({ token: "t2", workspaceId: "ws1" })
  h.handle.sync()
  assert.equal(h.connectCount, 2)
  h.last().open()
  assert.deepEqual(h.sent[h.sent.length - 1], {
    type: "auth",
    token: "t2",
    workspaceId: "ws1",
  })
})
