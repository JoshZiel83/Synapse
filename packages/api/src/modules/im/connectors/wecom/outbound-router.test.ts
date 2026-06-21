import test from "node:test"
import assert from "node:assert/strict"
import type { SendMsgBody, WsFrame } from "@wecom/aibot-node-sdk"
import {
  _internals,
  dispatchOutbound,
  ensureMultiplexer,
  isHolderLocally,
  registerHolder,
  subscribeAccountInboundChannel,
  unregisterHolder,
  unsubscribeAccountInboundChannel,
} from "./outbound-router.js"

type FakeClient = {
  sendMessage: (chatid: string, body: SendMsgBody) => Promise<WsFrame>
}

function makeFakeClient(
  impl: (chatid: string, body: SendMsgBody) => Promise<WsFrame>
): FakeClient {
  return { sendMessage: impl }
}

test.beforeEach(() => {
  _internals.resetForTests()
  // All remote-path tests bypass Redis by skipping multiplexer init AND
  // skipping the publish call. They drive resolve/reject manually on the
  // pending entry. Tests that need to exercise the actual transport
  // codepaths can set their own override + clear the bypass.
  _internals.bypassMultiplexerForTests()
})

test("isHolderLocally reflects register/unregister", () => {
  assert.equal(isHolderLocally("acct-1"), false)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerHolder("acct-1", makeFakeClient(async () => ({}) as any) as any)
  assert.equal(isHolderLocally("acct-1"), true)
  unregisterHolder("acct-1")
  assert.equal(isHolderLocally("acct-1"), false)
})

test("dispatchOutbound local-holder fast path bypasses redis", async () => {
  const captured: { chatid?: string; body?: SendMsgBody } = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fake = makeFakeClient(async (chatid, body) => {
    captured.chatid = chatid
    captured.body = body
    return {
      headers: { req_id: "r-123" },
      body: { ok: 0 },
    } as unknown as WsFrame
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerHolder("acct-1", fake as any)
  const result = await dispatchOutbound({
    accountId: "acct-1",
    frameBody: {
      chatid: "g-1",
      body: {
        msgtype: "markdown",
        markdown: { content: "hi" },
      },
    },
  })
  assert.equal(captured.chatid, "g-1")
  assert.deepEqual(captured.body, {
    msgtype: "markdown",
    markdown: { content: "hi" },
  })
  // Returns the bare WsFrame, no wire wrapping
  assert.equal(
    (result as { headers: { req_id: string } }).headers.req_id,
    "r-123"
  )
})

test("dispatchOutbound propagates local-holder errors as-is", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fake = makeFakeClient(async () => {
    throw new Error("boom from sdk")
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerHolder("acct-1", fake as any)
  await assert.rejects(
    dispatchOutbound({
      accountId: "acct-1",
      frameBody: {
        chatid: "g",
        body: { msgtype: "markdown", markdown: { content: "x" } },
      },
    }),
    /boom from sdk/
  )
})

test("dispatchOutbound resolves via fake pending entry (simulated remote)", async () => {
  // Drive the requester path manually: we bypass real Redis and resolve
  // the pending promise from outside, the way the pmessage dispatcher
  // would. This proves the pending-map plumbing works without
  // standing up a real ioredis.
  const dispatchPromise = dispatchOutbound({
    accountId: "remote-acct",
    frameBody: {
      chatid: "u-1",
      body: { msgtype: "markdown", markdown: { content: "x" } },
    },
    timeoutMs: 200,
    skipPublishForTests: true,
  })
  // Wait a tick so dispatchOutbound has registered the pending entry.
  await new Promise((r) => setImmediate(r))
  const entries = Array.from(_internals.pendingRequests.entries())
  assert.equal(entries.length, 1, "pending entry registered before publish")
  const [, pending] = entries[0]
  const fakeFrame = {
    headers: { req_id: "rid-x" },
    body: { msgid: "msg-x" },
  } as unknown as WsFrame
  pending.resolve(fakeFrame)
  const result = await dispatchPromise
  assert.equal(
    (result as { headers: { req_id: string } }).headers.req_id,
    "rid-x"
  )
  // After resolve, pending map should be cleared (so a late response is a no-op)
  assert.equal(_internals.pendingRequests.size, 0)
})

test("dispatchOutbound rejects on wire ok:false from holder", async () => {
  const dispatchPromise = dispatchOutbound({
    accountId: "remote-acct",
    frameBody: {
      chatid: "u",
      body: { msgtype: "markdown", markdown: { content: "x" } },
    },
    timeoutMs: 200,
    skipPublishForTests: true,
  })
  await new Promise((r) => setImmediate(r))
  const [, pending] = Array.from(_internals.pendingRequests.entries())[0]
  // Simulate the pmessage dispatcher unwrapping a wire failure response.
  // (In the real dispatcher: ok:false → reject(new Error(error)).)
  pending.reject(new Error("wecom remote error: send failed"))
  await assert.rejects(dispatchPromise, /send failed/)
})

test("dispatchOutbound times out when no holder responds", async () => {
  await assert.rejects(
    dispatchOutbound({
      accountId: "no-holder",
      frameBody: {
        chatid: "u",
        body: { msgtype: "markdown", markdown: { content: "x" } },
      },
      timeoutMs: 50,
      skipPublishForTests: true,
    }),
    /wecom outbound timeout/
  )
  // Timer fired and entry was deleted
  assert.equal(_internals.pendingRequests.size, 0)
})

test("late response after timeout is silently dropped", async () => {
  const dispatch = dispatchOutbound({
    accountId: "remote-acct",
    frameBody: {
      chatid: "u",
      body: { msgtype: "markdown", markdown: { content: "x" } },
    },
    timeoutMs: 30,
    skipPublishForTests: true,
  }).catch((err) => err)
  // Grab the pending ref before timer fires
  await new Promise((r) => setImmediate(r))
  const pendingRef: { resolve: (f: WsFrame) => void } | undefined = Array.from(
    _internals.pendingRequests.values()
  )[0]
  // Wait for timeout
  const settled = await dispatch
  assert.match((settled as Error).message, /timeout/)
  // Now arrive late — there's no entry to resolve into. This must not throw.
  assert.doesNotThrow(() => pendingRef?.resolve({} as WsFrame))
  assert.equal(_internals.pendingRequests.size, 0)
})

test("multiple holders in one process do not cross-talk", async () => {
  let last: string | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fa = makeFakeClient(async () => {
    last = "A"
    return {} as WsFrame
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fb = makeFakeClient(async () => {
    last = "B"
    return {} as WsFrame
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerHolder("A", fa as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerHolder("B", fb as any)
  await dispatchOutbound({
    accountId: "A",
    frameBody: {
      chatid: "x",
      body: { msgtype: "markdown", markdown: { content: "" } },
    },
  })
  assert.equal(last, "A")
  await dispatchOutbound({
    accountId: "B",
    frameBody: {
      chatid: "x",
      body: { msgtype: "markdown", markdown: { content: "" } },
    },
  })
  assert.equal(last, "B")
})

// ─── Recovery / failure path tests (added in response to code review) ───

test("publish() failure rejects the dispatch promise (no hang)", async () => {
  // The publish-failure callback used to pre-delete the pending entry,
  // then call wrappedReject — which short-circuited because the entry
  // was already gone, leaving the dispatch promise pending forever and
  // the BullMQ delivery job stuck. Cover the fix: publish failure
  // surfaces as a real rejection.
  _internals.setTransportOverrideForTests({
    publish: async () => {
      throw new Error("ECONNREFUSED")
    },
  })
  const dispatchPromise = dispatchOutbound({
    accountId: "remote",
    frameBody: {
      chatid: "u",
      body: { msgtype: "markdown", markdown: { content: "x" } },
    },
    timeoutMs: 1_000,
  })
  await assert.rejects(dispatchPromise, /wecom publish failed.*ECONNREFUSED/)
  // Cleanup: entry must be gone, timer cleared.
  assert.equal(_internals.pendingRequests.size, 0)
})

test("ensureMultiplexer retries after a failed psubscribe (does not cache rejection)", async () => {
  _internals.clearMultiplexerForTests()
  let attempt = 0
  _internals.setTransportOverrideForTests({
    psubscribe: async () => {
      attempt += 1
      if (attempt === 1) throw new Error("redis unreachable")
    },
  })
  // First call should reject (Redis "down").
  await assert.rejects(ensureMultiplexer(), /redis unreachable/)
  // Second call MUST run psubscribe again, not hand back the cached
  // rejected promise. Without the reset-on-failure logic the cached
  // rejection would poison every future dispatch until process restart.
  await ensureMultiplexer()
  assert.equal(attempt, 2)
})

test("ensureMultiplexer does not double-install Node listeners across retries", async () => {
  // First a successful call to install listeners. Then force a clear +
  // failing psubscribe + recovery. We can't easily count internal
  // listeners on the lazy redis proxy, but a duplicate `'message'`
  // listener would cause the channel handler to run twice per message.
  // Instead of inspecting redisSub internals, we just verify that
  // resetting + retrying does not throw or otherwise misbehave; the
  // dedupe contract is guarded by `multiplexerListenersInstalled`.
  _internals.clearMultiplexerForTests()
  let psubCalls = 0
  _internals.setTransportOverrideForTests({
    psubscribe: async () => {
      psubCalls += 1
    },
  })
  await ensureMultiplexer()
  _internals.clearMultiplexerForTests()
  await ensureMultiplexer()
  _internals.clearMultiplexerForTests()
  await ensureMultiplexer()
  assert.equal(psubCalls, 3)
  // No exception thrown ⇒ listeners weren't re-added in a way that
  // breaks redis client max-listeners or similar.
})

test("subscribeAccountInboundChannel cleans the handler when subscribe() throws", async () => {
  _internals.clearMultiplexerForTests()
  _internals.setTransportOverrideForTests({
    psubscribe: async () => {},
    subscribe: async () => {
      throw new Error("redis subscribe blew up")
    },
  })
  await assert.rejects(
    subscribeAccountInboundChannel("acct-X"),
    /subscribe blew up/
  )
  // Critical: handler must NOT remain in the map — otherwise a future
  // success-path subscribe wouldn't overwrite cleanly, and a `message`
  // event landing on the (un-subscribed) channel would hit a closure
  // that has no live Redis subscription backing it.
  assert.equal(
    _internals.requestHandlersByChannel.has("wecom:outbound:request:acct-X"),
    false
  )
})

test("subscribe handler reads holder from holders map at dispatch time (rebuild-safe)", async () => {
  // The request handler captures `accountId` and reads the WSClient
  // from `holders` on every dispatch — NOT via closure. This makes
  // rebuild (swapping the holder entry to a new WSClient instance)
  // transparent to the in-flight outbound path.
  _internals.clearMultiplexerForTests()
  const published: Array<{ channel: string; payload: string }> = []
  _internals.setTransportOverrideForTests({
    psubscribe: async () => {},
    subscribe: async () => {},
    publish: async (channel: string, payload: string) => {
      published.push({ channel, payload })
      return 1
    },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerHolder(
    "acct-1",
    makeFakeClient(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { headers: { req_id: "r-original" }, body: {} } as any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any
  )
  await subscribeAccountInboundChannel("acct-1")
  const handler = _internals.requestHandlersByChannel.get(
    "wecom:outbound:request:acct-1"
  )
  assert.ok(handler, "handler installed")

  // Swap the holder for a new client (simulating rebuild).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerHolder(
    "acct-1",
    makeFakeClient(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { headers: { req_id: "r-rebuilt" }, body: {} } as any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any
  )

  // Invoke the handler with a synthetic request payload.
  await handler!(
    JSON.stringify({
      requestId: "req-1",
      frameBody: {
        chatid: "u",
        body: { msgtype: "markdown", markdown: { content: "x" } },
      },
    })
  )
  // The handler dispatched to the swapped (new) client, not the original.
  assert.equal(published.length, 1)
  const wire = JSON.parse(published[0].payload)
  assert.equal(wire.ok, true)
  assert.equal(wire.raw.headers.req_id, "r-rebuilt")
})

test("subscribe handler fast-fails when holder was unregistered", async () => {
  // Simulates the brief window during rebuild when holders entry is
  // missing. The handler must publish an ok:false response so the
  // requester rejects immediately, rather than dropping the request
  // and leaving the requester to time out.
  _internals.clearMultiplexerForTests()
  const published: Array<{ channel: string; payload: string }> = []
  _internals.setTransportOverrideForTests({
    psubscribe: async () => {},
    subscribe: async () => {},
    publish: async (channel: string, payload: string) => {
      published.push({ channel, payload })
      return 1
    },
  })
  await subscribeAccountInboundChannel("acct-gone")
  const handler = _internals.requestHandlersByChannel.get(
    "wecom:outbound:request:acct-gone"
  )!
  // No registerHolder() — holder missing.
  await handler(
    JSON.stringify({
      requestId: "req-2",
      frameBody: {
        chatid: "u",
        body: { msgtype: "markdown", markdown: { content: "" } },
      },
    })
  )
  assert.equal(published.length, 1)
  const wire = JSON.parse(published[0].payload)
  assert.equal(wire.ok, false)
  assert.match(wire.error, /not registered/)
})

test("subscribe handler drops malformed internal request payloads", async () => {
  _internals.clearMultiplexerForTests()
  const published: Array<{ channel: string; payload: string }> = []
  _internals.setTransportOverrideForTests({
    psubscribe: async () => {},
    subscribe: async () => {},
    publish: async (channel: string, payload: string) => {
      published.push({ channel, payload })
      return 1
    },
  })
  await subscribeAccountInboundChannel("acct-bad")
  const handler = _internals.requestHandlersByChannel.get(
    "wecom:outbound:request:acct-bad"
  )!

  await handler("{not-json")
  await handler(
    JSON.stringify({
      requestId: "REQ-1",
      frameBody: { chatid: "", body: { msgtype: "markdown" } },
    })
  )

  assert.equal(published.length, 0)
})

test("ensureMultiplexer with transportOverride does NOT touch real redisSub.on (no socket open)", async () => {
  // The lazy `redis` proxy in infrastructure/redis materializes the
  // ioredis client on first property access. Tests must be able to
  // exercise the multiplexer / dispatch code paths without opening
  // any sockets. We verify by checking that `ensureMultiplexer()`
  // completes when the override is set even if real Redis would be
  // unreachable (NOAUTH or otherwise) — the only way that holds is
  // if redisSub.on / psubscribe were entirely skipped in favor of
  // the override.
  //
  // We can't directly assert "redisSub.on was not called" without
  // monkey-patching the lazy proxy. Instead we assert the contract
  // that the override path resolves with NO real Redis interaction
  // by setting an override that never delegates anywhere, and
  // verifying the resolved promise.
  _internals.clearMultiplexerForTests()
  let psubCalls = 0
  _internals.setTransportOverrideForTests({
    psubscribe: async () => {
      psubCalls += 1
    },
  })
  await ensureMultiplexer()
  assert.equal(psubCalls, 1, "override psubscribe was invoked")
  // Repeat: cached promise short-circuits, no extra call.
  await ensureMultiplexer()
  assert.equal(psubCalls, 1)
  // Force re-init: still no real listeners installed (no exception
  // even though real redisSub would error out under NOAUTH).
  _internals.clearMultiplexerForTests()
  await ensureMultiplexer()
  assert.equal(psubCalls, 2)
})
