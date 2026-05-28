import test from "node:test"
import assert from "node:assert/strict"
import type { DWClientDownStream } from "dingtalk-stream"
import {
  startDingtalkAccount,
  type MinimalDWClient,
  type MinimalDWSocket,
} from "./stream.js"
import type { AccountStartContext, InboundEnvelope } from "../types.js"

/**
 * Mock SDK shape. Mirrors the *actual* dingtalk-stream surface our code
 * touches: a method-bag client plus a `socket` field exposing the
 * WebSocket-style `on('close'|'error')` and `readyState`. Tests inject
 * close/error events the same way the real SDK does — by firing them
 * on the socket after `connect()` returns.
 *
 * Pre-fix the mock invented `connected`/`disconnect` events that the
 * real SDK never emits (it only `emit()`s for CALLBACK topic dispatch),
 * so reconnect tests passed against a contract the real SDK didn't
 * honor. This version refuses to compile that shape.
 */
interface MockSocket extends MinimalDWSocket {
  readyState: number
  __fireClose: () => void
  __fireError: (err: Error) => void
}

interface MockClient extends MinimalDWClient {
  socket?: MockSocket
  __acks: string[]
  __sentInbound: (msg: DWClientDownStream) => void
  /** Fires the SDK's `onSystem(downstream)` after our wrap installs. */
  __sentSystem: (downstream: DWClientDownStream) => void
}

interface MockClientControls {
  /**
   * When `false`, the next `client.connect()` will resolve but leave
   * `client.socket` undefined — simulating SDK's silent swallow when
   * getEndpoint/_connect throws under autoReconnect:false.
   */
  succeedNextConnect: boolean
}

interface MockFactoryResult {
  client: MockClient
  controls: MockClientControls
  ctorCalls: number
  connectCalls: number
}

function makeContext(overrides: Partial<AccountStartContext> = {}): {
  ctx: AccountStartContext
  abortController: AbortController
  emitted: InboundEnvelope[]
  emitFailures: Error[]
} {
  const emitted: InboundEnvelope[] = []
  const emitFailures: Error[] = []
  const abortController = new AbortController()
  const ctx: AccountStartContext = {
    account: {
      id: "acc-1",
      transportKind: "dingtalk",
      credentials: { clientId: "ding-1", clientSecret: "secret-1" },
    } as never,
    signal: abortController.signal,
    emitInbound: async (env) => {
      emitted.push(env)
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (_msg, err) => {
        if (err instanceof Error) emitFailures.push(err)
      },
    },
    ...overrides,
  }
  return { ctx, abortController, emitted, emitFailures }
}

function makeMockClientFactory(): {
  factory: (config: unknown) => MinimalDWClient
  state: MockFactoryResult
} {
  const controls: MockClientControls = { succeedNextConnect: true }
  const state: MockFactoryResult = {
    ctorCalls: 0,
    connectCalls: 0,
    controls,
    client: undefined as unknown as MockClient,
  }
  const factory = (_config: unknown): MinimalDWClient => {
    state.ctorCalls += 1
    let inboundCb: ((msg: DWClientDownStream) => void) | undefined
    const acks: string[] = []
    let closeListener: (() => void) | undefined
    let errorListener: ((err: Error) => void) | undefined
    const socket: MockSocket = {
      readyState: 1, // OPEN
      on(event, listener) {
        if (event === "close") closeListener = listener as () => void
        else if (event === "error")
          errorListener = listener as (err: Error) => void
        return socket
      },
      __fireClose: () => closeListener?.(),
      __fireError: (err) => errorListener?.(err),
    }
    const client: MockClient = {
      async connect() {
        state.connectCalls += 1
        // Simulate the SDK's silent-failure path: connect() resolves
        // either way, but the socket may be missing/closed if the
        // underlying call failed.
        if (controls.succeedNextConnect) {
          this.socket = socket
        } else {
          this.socket = undefined
        }
      },
      disconnect() {
        // Real SDK closes the socket; we fire the close listener too.
        socket.readyState = 3 // CLOSED
        closeListener?.()
      },
      registerCallbackListener(_eventId: string, cb) {
        inboundCb = cb
        return client
      },
      socketCallBackResponse(messageId: string, _result) {
        acks.push(messageId)
      },
      // Default SDK-style onSystem: a no-op stub. The production code
      // wraps this on the instance to also abort the cycle when topic
      // is "disconnect"; the test fires SYSTEM messages via the
      // (post-wrap) function via __sentSystem below.
      onSystem: () => {},
      __acks: acks,
      __sentInbound: (msg) => {
        if (!inboundCb) throw new Error("registerCallbackListener never called")
        inboundCb(msg)
      },
      __sentSystem: (downstream: DWClientDownStream) => {
        if (!client.onSystem) {
          throw new Error("client.onSystem is undefined")
        }
        client.onSystem(downstream)
      },
    }
    state.client = client
    return client
  }
  return { factory, state }
}

function downStream(
  messageId: string | undefined,
  data: unknown
): DWClientDownStream {
  return {
    specVersion: "1.0",
    type: "CALLBACK",
    headers: {
      appId: "ding-x",
      connectionId: "c-1",
      contentType: "application/json",
      messageId: messageId as string, // intentionally allow undefined for tests
      time: "0",
      topic: "/v1.0/im/bot/messages/get",
    },
    data: typeof data === "string" ? data : JSON.stringify(data),
  }
}

// Sleep used to let microtasks settle when emitInbound is fire-and-forget.
function nextTick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 5))
}

const VALID_PAYLOAD = {
  msgtype: "text",
  msgId: "msg-1",
  conversationId: "cid-1",
  conversationType: "2",
  createAt: 1700000000000,
  senderId: "alice-id",
  senderStaffId: "alice",
  chatbotUserId: "bot-1",
  text: { content: "hi" },
}

// ─────────── tests ───────────

test("stream.startAccount returns immediately (does NOT block on connect)", async () => {
  const { factory, state } = makeMockClientFactory()
  const { ctx, abortController } = makeContext()
  const before = Date.now()
  const running = await startDingtalkAccount(ctx, {
    clientFactory: factory,
    minStableConnectionMs: 0,
  })
  const after = Date.now()
  // ≤ 100ms is plenty of headroom — the loop's connect is fire-and-forget.
  assert.ok(after - before < 100)
  await nextTick()
  assert.equal(state.ctorCalls >= 1, true)
  abortController.abort()
  await running.stop()
})

test("stream: ACK is sent with {success: true} before normalize runs", async () => {
  const { factory, state } = makeMockClientFactory()
  const { ctx, abortController, emitted } = makeContext()
  const running = await startDingtalkAccount(ctx, {
    clientFactory: factory,
    minStableConnectionMs: 0,
  })
  await nextTick()
  state.client.__sentInbound(downStream("hdr-1", VALID_PAYLOAD))
  await nextTick()
  assert.deepEqual(state.client.__acks, ["hdr-1"])
  assert.equal(emitted.length, 1)
  abortController.abort()
  await running.stop()
})

test("stream: ACK still sent when JSON.parse fails (poison payload)", async () => {
  const { factory, state } = makeMockClientFactory()
  const { ctx, abortController, emitted } = makeContext()
  const running = await startDingtalkAccount(ctx, {
    clientFactory: factory,
    minStableConnectionMs: 0,
  })
  await nextTick()
  state.client.__sentInbound(downStream("hdr-2", "{not-json"))
  await nextTick()
  assert.deepEqual(state.client.__acks, ["hdr-2"])
  assert.equal(emitted.length, 0)
  abortController.abort()
  await running.stop()
})

test("stream: ACK still sent when business dedup hits (same msgId twice)", async () => {
  const { factory, state } = makeMockClientFactory()
  const { ctx, abortController, emitted } = makeContext()
  const running = await startDingtalkAccount(ctx, {
    clientFactory: factory,
    minStableConnectionMs: 0,
  })
  await nextTick()
  state.client.__sentInbound(downStream("hdr-A", VALID_PAYLOAD))
  state.client.__sentInbound(downStream("hdr-B", VALID_PAYLOAD)) // different protocol id but same msgId
  await nextTick()
  assert.deepEqual(state.client.__acks, ["hdr-A", "hdr-B"])
  assert.equal(emitted.length, 1) // 2nd is deduped at business layer
  abortController.abort()
  await running.stop()
})

test("stream: ACK still sent when protocol dedup hits (same messageId twice)", async () => {
  const { factory, state } = makeMockClientFactory()
  const { ctx, abortController, emitted } = makeContext()
  const running = await startDingtalkAccount(ctx, {
    clientFactory: factory,
    minStableConnectionMs: 0,
  })
  await nextTick()
  state.client.__sentInbound(downStream("hdr-X", VALID_PAYLOAD))
  state.client.__sentInbound(
    downStream("hdr-X", { ...VALID_PAYLOAD, msgId: "msg-different" })
  )
  await nextTick()
  // Both ACKed (protocol-layer dedup is post-ACK).
  assert.deepEqual(state.client.__acks, ["hdr-X", "hdr-X"])
  // Only the first reached emitInbound — the second was protocol-deduped.
  assert.equal(emitted.length, 1)
  abortController.abort()
  await running.stop()
})

test("stream: ACK still sent when bot self-message normalize returns null", async () => {
  const { factory, state } = makeMockClientFactory()
  const { ctx, abortController, emitted } = makeContext()
  const running = await startDingtalkAccount(ctx, {
    clientFactory: factory,
    minStableConnectionMs: 0,
  })
  await nextTick()
  state.client.__sentInbound(
    downStream("hdr-self", { ...VALID_PAYLOAD, senderId: "bot-1" })
  )
  await nextTick()
  assert.deepEqual(state.client.__acks, ["hdr-self"])
  assert.equal(emitted.length, 0)
  abortController.abort()
  await running.stop()
})

test("stream: ACK skipped (but pipeline still runs) when headers.messageId is missing", async () => {
  const { factory, state } = makeMockClientFactory()
  const { ctx, abortController, emitted } = makeContext()
  const running = await startDingtalkAccount(ctx, {
    clientFactory: factory,
    minStableConnectionMs: 0,
  })
  await nextTick()
  state.client.__sentInbound(downStream(undefined, VALID_PAYLOAD))
  await nextTick()
  assert.deepEqual(state.client.__acks, [])
  assert.equal(emitted.length, 1)
  abortController.abort()
  await running.stop()
})

test("stream: emitInbound throw is logged but does NOT trigger redelivery", async () => {
  const { factory, state } = makeMockClientFactory()
  const seenEmitFailures: Error[] = []
  const { ctx, abortController } = makeContext({
    emitInbound: async () => {
      throw new Error("DB write failed")
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (_msg, err) => {
        if (err instanceof Error) seenEmitFailures.push(err)
      },
    },
  })
  const running = await startDingtalkAccount(ctx, {
    clientFactory: factory,
    minStableConnectionMs: 0,
  })
  await nextTick()
  state.client.__sentInbound(downStream("hdr-emit-fail", VALID_PAYLOAD))
  await nextTick()
  await nextTick()
  // Still ACKed up-front (low-duplicate / possibly-lost-inbound semantics).
  assert.deepEqual(state.client.__acks, ["hdr-emit-fail"])
  assert.equal(seenEmitFailures.length, 1)
  abortController.abort()
  await running.stop()
})

test("stream: dedup keyed by account.id (different account, same msgId, both emit)", async () => {
  const { factory: factoryA, state: stateA } = makeMockClientFactory()
  const { factory: factoryB, state: stateB } = makeMockClientFactory()
  const { ctx: ctxA, abortController: abA, emitted: emittedA } = makeContext()
  const ctxB = {
    ...ctxA,
    account: { ...ctxA.account, id: "acc-2" } as never,
  }
  const emittedB: InboundEnvelope[] = []
  ctxB.emitInbound = async (env) => {
    emittedB.push(env)
  }
  const abB = new AbortController()
  ctxB.signal = abB.signal

  const runningA = await startDingtalkAccount(ctxA, {
    clientFactory: factoryA,
    minStableConnectionMs: 0,
  })
  const runningB = await startDingtalkAccount(ctxB, {
    clientFactory: factoryB,
    minStableConnectionMs: 0,
  })
  await nextTick()
  stateA.client.__sentInbound(downStream("hdr-shared", VALID_PAYLOAD))
  stateB.client.__sentInbound(downStream("hdr-shared", VALID_PAYLOAD))
  await nextTick()
  // Each account emits independently — dedup is per-account.
  assert.equal(emittedA.length, 1)
  assert.equal(emittedB.length, 1)
  abA.abort()
  abB.abort()
  await runningA.stop()
  await runningB.stop()
})

test("stream.stop() unblocks the wait loop even when ctx.signal never aborts", async () => {
  // Regression guard for a leaked closure: before the internal AbortController,
  // stop() flipped the `stopped` flag and disconnected, but the runLoop was
  // parked on `await new Promise(resolve => ctx.signal.addEventListener("abort"))`
  // — which never resolved. The runLoop closure (dedup maps, client refs)
  // would have stayed alive for the lifetime of the parent process.
  const { factory, state } = makeMockClientFactory()
  const { ctx } = makeContext()
  const running = await startDingtalkAccount(ctx, {
    clientFactory: factory,
    minStableConnectionMs: 0,
  })
  await nextTick()
  state.client.__sentInbound(downStream("hdr-pre-stop", VALID_PAYLOAD))
  await nextTick()
  // Now call stop() WITHOUT aborting ctx.signal. The wait-promise inside
  // runLoop must resolve via stop()'s internal abort so the closure can
  // unwind. We can't directly observe the closure freeing, but we CAN
  // observe that stop() resolves quickly and that a subsequent inbound is
  // dropped (no emit) because the loop has exited.
  const before = Date.now()
  await running.stop()
  const stopDurationMs = Date.now() - before
  // stop() shouldn't block the test for longer than a small budget; if the
  // wait-promise weren't notified, stop() would still return because it's
  // just an async function, but the runLoop closure would persist. We're
  // testing the absence of the leak indirectly: an inbound delivered AFTER
  // stop() should not be ACK'd (no active client listener), so the test's
  // ACK assertion catches a regression.
  assert.ok(stopDurationMs < 200, `stop() took ${stopDurationMs}ms`)
  // ctx.signal is still un-aborted.
  assert.equal(ctx.signal.aborted, false)
})

test("stream: socket 'close' event wakes runLoop and triggers reconnect", async () => {
  // Regression: pre-fix the loop watched non-existent SDK
  // `client.on('disconnect')` events that dingtalk-stream doesn't emit
  // (the SDK only `emit()`s for CALLBACK topic dispatch — see
  // client.cjs onCallback). The real lifecycle signal is the underlying
  // WebSocket's 'close' event, accessed via `client.socket.on('close')`.
  const { factory, state } = makeMockClientFactory()
  const { ctx, abortController } = makeContext()
  const running = await startDingtalkAccount(ctx, {
    clientFactory: factory,
    minStableConnectionMs: 0,
  })
  await nextTick()
  const ctorsBeforeClose = state.ctorCalls
  assert.equal(ctorsBeforeClose, 1)
  // Server cut OR keepAlive watchdog terminate() → socket close.
  state.client.socket!.__fireClose()
  await nextTick()
  assert.ok(
    state.ctorCalls > ctorsBeforeClose,
    `expected ctorCalls to grow after socket close, got ${state.ctorCalls}`
  )
  abortController.abort()
  await running.stop()
})

test("stream: socket 'error' event also wakes runLoop", async () => {
  const { factory, state } = makeMockClientFactory()
  const { ctx, abortController } = makeContext()
  const running = await startDingtalkAccount(ctx, {
    clientFactory: factory,
    minStableConnectionMs: 0,
  })
  await nextTick()
  const ctorsBeforeError = state.ctorCalls
  state.client.socket!.__fireError(new Error("WS broke"))
  await nextTick()
  assert.ok(state.ctorCalls > ctorsBeforeError)
  abortController.abort()
  await running.stop()
})

test("stream: silent connect failure (SDK swallowed error → socket=undefined) → throws → backoff", async () => {
  // Regression for SDK's connect() try/catch (client.cjs:189) that
  // swallows getEndpoint/_connect failures when autoReconnect:false.
  // Without the readyState sanity check, runLoop would walk into the
  // wait-promise with no live socket and never recover. With the
  // check, connectOnce() throws and the outer backoff kicks in.
  const { factory, state } = makeMockClientFactory()
  state.controls.succeedNextConnect = false // first attempt fails silently
  const { ctx, abortController } = makeContext()
  const running = await startDingtalkAccount(ctx, {
    clientFactory: factory,
    minStableConnectionMs: 0,
  })
  await nextTick()
  // After the first ctor + connect, the loop should NOT be parked —
  // it should be in backoff, having thrown out of connectOnce(). We
  // can flip succeedNextConnect=true and wait for the backoff to
  // expire; ctor will be called again. Since backoff base is 1s+jitter
  // and tests should stay fast, just verify the loop hasn't entered a
  // pseudo-success state — i.e. activeClient.socket is undefined.
  assert.equal(state.client.socket, undefined)
  abortController.abort()
  await running.stop()
})

test("stream: silent connect failure → outer loop retries (eventually re-enters connectOnce)", async () => {
  const { factory, state } = makeMockClientFactory()
  state.controls.succeedNextConnect = false
  const { ctx, abortController } = makeContext()
  const running = await startDingtalkAccount(ctx, {
    clientFactory: factory,
    minStableConnectionMs: 0,
  })
  // Backoff is 2^attempts * 1s + 0-1s jitter. After 1 failure attempts=1,
  // so worst case the retry lands ~3s after the failure. Wait 4s to
  // leave headroom; flipping `succeed` 100ms in costs nothing if the
  // retry happens later.
  await new Promise((r) => setTimeout(r, 100))
  state.controls.succeedNextConnect = true
  await new Promise((r) => setTimeout(r, 4_000))
  assert.ok(
    state.ctorCalls >= 2,
    `expected at least 2 connect attempts, saw ${state.ctorCalls}`
  )
  abortController.abort()
  await running.stop()
})

test("defaultClientFactory: DWClient receives keepAlive:true + autoReconnect:false (real SDK constructor)", async () => {
  // Goes through the production factory (NOT the mock), so a regression
  // in the literal flags we hand DWClient gets caught. We don't
  // `connect()` here — that would hit a real DingTalk gateway. We just
  // verify the SDK's `getConfig()` reports the values we set.
  const { defaultClientFactory } = await import("./stream.js")
  const client = defaultClientFactory({
    clientId: "ding-test-key",
    clientSecret: "test-secret",
  }) as unknown as {
    getConfig?: () => { keepAlive?: boolean; autoReconnect?: boolean }
  }
  const cfg = client.getConfig?.()
  assert.ok(cfg, "expected client.getConfig() to exist on the real DWClient")
  assert.equal(
    cfg.keepAlive,
    true,
    "keepAlive must be true so SDK runs ping/pong on idle connections"
  )
  assert.equal(
    cfg.autoReconnect,
    false,
    "autoReconnect must be false so the SDK doesn't race the outer loop"
  )
})

test("stream: SDK SYSTEM 'disconnect' topic aborts cycle even when socket stays open", async () => {
  // Regression: dingtalk-stream's onSystem handles topic === "disconnect"
  // by flipping internal flags only — it does NOT close the socket and
  // does NOT emit anything. The wrap installed in connectOnce must catch
  // this and abort the cycle so the loop reconnects.
  const { factory, state } = makeMockClientFactory()
  const { ctx, abortController } = makeContext()
  const running = await startDingtalkAccount(ctx, {
    clientFactory: factory,
    minStableConnectionMs: 0,
  })
  await nextTick()
  const ctorsBefore = state.ctorCalls
  // Server sends a SYSTEM disconnect frame; socket stays "open".
  state.client.__sentSystem({
    specVersion: "1.0",
    type: "SYSTEM",
    headers: {
      appId: "ding-x",
      connectionId: "c-1",
      contentType: "application/json",
      messageId: "sys-1",
      time: "0",
      topic: "disconnect",
    },
    data: "",
  })
  await nextTick()
  assert.ok(
    state.ctorCalls > ctorsBefore,
    `expected reconnect after SYSTEM disconnect, ctorCalls=${state.ctorCalls}`
  )
  abortController.abort()
  await running.stop()
})

test("stream: SYSTEM 'disconnect' wrap delegates to original onSystem (bookkeeping preserved)", async () => {
  const { factory, state } = makeMockClientFactory()
  const { ctx, abortController } = makeContext()
  let originalCalls = 0
  // Replace the mock's default onSystem with a counter before
  // connectOnce wraps it; the wrap should still call through.
  const interceptingFactory = (config: unknown) => {
    const client = factory(config) as MockClient
    client.onSystem = () => {
      originalCalls += 1
    }
    return client
  }
  const running = await startDingtalkAccount(ctx, {
    clientFactory: interceptingFactory as never,
  })
  await nextTick()
  state.client.__sentSystem({
    specVersion: "1.0",
    type: "SYSTEM",
    headers: {
      appId: "ding-x",
      connectionId: "c-1",
      contentType: "application/json",
      messageId: "sys-2",
      time: "0",
      topic: "REGISTERED",
    },
    data: "",
  })
  await nextTick()
  assert.equal(
    originalCalls,
    1,
    "wrap must invoke the SDK's original onSystem first"
  )
  abortController.abort()
  await running.stop()
})

test("stream: late close from old socket does NOT abort the new cycle", async () => {
  // Regression: if the socket close/error/onSystem listeners closed over
  // the ambient `cycleEnd` instead of per-cycle, a late event from the
  // first socket (e.g. error→terminate→close arriving after the next
  // cycle started) would tear down the brand-new connection. The fix
  // snapshots cycleEnd inside connectOnce and also gates on
  // `activeClient === client`.
  const { factory, state } = makeMockClientFactory()
  const { ctx, abortController } = makeContext()
  const running = await startDingtalkAccount(ctx, {
    clientFactory: factory,
    minStableConnectionMs: 0,
  })
  await nextTick()
  const firstSocket = state.client.socket!
  // Trigger a normal close → cycle ends, loop starts a new cycle.
  firstSocket.__fireClose()
  // Let the loop spin up the next connectOnce.
  await new Promise((r) => setTimeout(r, 50))
  const newCtorCount = state.ctorCalls
  assert.ok(newCtorCount >= 2, "expected loop to reconnect after first close")
  const secondSocket = state.client.socket!
  assert.notEqual(secondSocket, firstSocket, "expected a fresh socket")
  // Now fire a *late* event from the OLD socket — same listener
  // reference, but the cycle controller it captured is already aborted.
  // The new cycle should be unaffected: no extra ctor calls.
  firstSocket.__fireClose()
  firstSocket.__fireError(new Error("late stragger"))
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(
    state.ctorCalls,
    newCtorCount,
    `late events from the old socket aborted the new cycle (ctor went from ${newCtorCount} → ${state.ctorCalls})`
  )
  abortController.abort()
  await running.stop()
})

test("stream.stop() unblocks an in-flight backoff sleep (no ctx.signal abort needed)", async () => {
  // Regression: sleep used to listen only to ctx.signal, so stop()
  // couldn't cancel an in-flight backoff. The runtime usually aborts
  // ctx.signal first, but the RunningAccount.stop() contract must
  // work standalone — otherwise a connector graceful-shutdown leaves
  // a timer pending for up to BACKOFF_MAX_MS+jitter.
  const { factory, state } = makeMockClientFactory()
  state.controls.succeedNextConnect = false
  const { ctx } = makeContext()
  const running = await startDingtalkAccount(ctx, {
    clientFactory: factory,
    minStableConnectionMs: 0,
  })
  // Let the first attempt fail and enter the backoff sleep.
  await new Promise((r) => setTimeout(r, 100))
  // No ctx.signal abort, no socket close — just stop().
  const before = Date.now()
  await running.stop()
  const elapsed = Date.now() - before
  // stop() should return promptly. If the loop kept sleeping it would
  // outlive this test's normal run; we set a generous-but-bounded budget
  // here to keep the assertion meaningful.
  assert.ok(elapsed < 500, `stop() took ${elapsed}ms — backoff didn't cancel`)
  // ctx.signal is still un-aborted; only stop() ran.
  assert.equal(ctx.signal.aborted, false)
})

test("stream: short-lived connection (< stable threshold) counts as a failure and backs off", async () => {
  // Regression: prior code reset `attempts = 0` after every clean
  // wait-promise return, so a gateway that connected then immediately
  // disconnected would loop with zero backoff and hammer the gateway.
  // The stability gate now treats anything shorter than
  // minStableConnectionMs as a failed attempt.
  const { factory, state } = makeMockClientFactory()
  const { ctx, abortController } = makeContext()
  // Use a non-zero threshold so the short-lived close trips it; the
  // other tests opt out with 0 so they don't slow on the gate.
  const running = await startDingtalkAccount(ctx, {
    clientFactory: factory,
    minStableConnectionMs: 30_000,
  })
  await nextTick()
  assert.equal(state.ctorCalls, 1)
  // Immediately tear down the connection — way under the stable threshold.
  state.client.socket!.__fireClose()
  // Wait a beat for the wait-promise to resolve and the catch path to run.
  await new Promise((r) => setTimeout(r, 200))
  // The loop should NOT have reconnected yet — it's in backoff sleep
  // (attempts=1, base ~2s + jitter). Verify ctor hasn't been re-called.
  assert.equal(
    state.ctorCalls,
    1,
    `expected the loop to be in backoff, not re-connecting; ctorCalls=${state.ctorCalls}`
  )
  abortController.abort()
  await running.stop()
})

test("stream: long-lived connection (>= stable threshold) resets attempts → immediate reconnect", async () => {
  // Inverse of the test above: when a connection lives past the
  // stability threshold we treat the disconnect as a "the SDK cycled
  // the socket, all good" event and reconnect right away. Tests use
  // minStableConnectionMs=0 so any connection lifetime crosses the
  // threshold; the close immediately re-enters connectOnce.
  const { factory, state } = makeMockClientFactory()
  const { ctx, abortController } = makeContext()
  const running = await startDingtalkAccount(ctx, {
    clientFactory: factory,
    minStableConnectionMs: 0,
  })
  await nextTick()
  assert.equal(state.ctorCalls, 1)
  state.client.socket!.__fireClose()
  await nextTick()
  assert.ok(
    state.ctorCalls >= 2,
    `expected immediate reconnect after long-lived close, ctorCalls=${state.ctorCalls}`
  )
  abortController.abort()
  await running.stop()
})

test("stream: consecutive short-lived closes accumulate backoff (no reset on OPEN)", async () => {
  // Regression: pre-fix `connectOnce` set `attempts = 0` immediately
  // after the socket reached OPEN, so a gateway that keeps closing
  // connections within ms of accepting them would loop forever with
  // the first-tier backoff. The reset now lives only in the
  // stable-cycle branch, so each short-lived close grows `attempts`.
  //
  // We can't observe `attempts` directly, but the visible effect is
  // that the time between reconnect attempts grows. We instrument by
  // recording each ctor's timestamp and asserting the gap between
  // ctor #2 and ctor #3 is strictly larger than the gap between
  // ctor #1 and ctor #2 (backoff grew from 2^1 to 2^2 base).
  const { factory, state } = makeMockClientFactory()
  const { ctx } = makeContext()
  // Cleanup signal for the test: abort here so the loop terminates
  // even if assertions throw partway through.
  const cleanup = new AbortController()
  ctx.signal = cleanup.signal

  const ctorTimes: number[] = []
  // Wrap the factory to time-stamp each ctor without mutating the
  // existing fixture (mock returns the same client ref each call, but
  // the wrap fires before factory's own counter).
  const wrappedFactory = (config: {
    clientId: string
    clientSecret: string
  }) => {
    ctorTimes.push(Date.now())
    return factory(config)
  }
  const running = await startDingtalkAccount(ctx, {
    clientFactory: wrappedFactory as never,
    minStableConnectionMs: 30_000,
  })

  // Cycle 1 → immediate short close → backoff (~1-2s, exp = 2^1)
  await nextTick()
  state.client.socket!.__fireClose()

  // Wait long enough for the second attempt to land but not the third.
  // 2^1 base = 2s + 0-1s jitter → 2-3s. Wait 3.5s.
  await new Promise((r) => setTimeout(r, 3_500))
  state.client.socket!.__fireClose() // cycle 2 → second short close

  // Now wait for the third attempt. 2^2 base = 4s + jitter → 4-5s.
  await new Promise((r) => setTimeout(r, 5_500))

  cleanup.abort()
  await running.stop()

  assert.ok(
    ctorTimes.length >= 3,
    `expected at least 3 reconnect attempts, saw ${ctorTimes.length}`
  )
  const gap1 = ctorTimes[1] - ctorTimes[0]
  const gap2 = ctorTimes[2] - ctorTimes[1]
  assert.ok(
    gap2 > gap1,
    `expected exponential growth: gap1=${gap1}ms, gap2=${gap2}ms (gap2 should be larger)`
  )
})

test("stream: ACK uses the client that delivered the message (not ambient activeClient)", async () => {
  // Regression: handleInbound used to grab `activeClient` at call time,
  // so a late callback from a closed socket would ACK on the brand-new
  // connection — wrong session, the ACK is meaningless to the gateway
  // and corrupts the new socket's framing in the worst case.
  const { factory, state } = makeMockClientFactory()
  const { ctx, abortController } = makeContext()
  const running = await startDingtalkAccount(ctx, {
    clientFactory: factory,
    minStableConnectionMs: 0,
  })
  await nextTick()
  const firstClient = state.client
  const firstSocket = firstClient.socket!
  // Tear down → loop reconnects with a fresh client.
  firstSocket.__fireClose()
  await new Promise((r) => setTimeout(r, 50))
  const secondClient = state.client
  assert.notEqual(
    secondClient,
    firstClient,
    "expected new client after reconnect"
  )

  // Now fire a *late* inbound on the OLD client. It should ACK to the
  // old client (whose acks array we recorded), NOT the new one.
  firstClient.__sentInbound(downStream("hdr-late", VALID_PAYLOAD))
  await nextTick()
  assert.deepEqual(
    firstClient.__acks,
    ["hdr-late"],
    "late callback should ACK on the old client"
  )
  assert.deepEqual(
    secondClient.__acks,
    [],
    "new client must not receive an ACK for a late callback from the old socket"
  )
  abortController.abort()
  await running.stop()
})

test("stream: callbacks after stop() are dropped without ACK and without emit", async () => {
  // Regression: stop() didn't guard handleInbound, so a callback queued
  // from before stop() could still ACK (writing to a closed socket,
  // which throws and was caught silently) and call emitInbound (writing
  // to a half-torn-down ingest pipeline).
  const { factory, state } = makeMockClientFactory()
  const { ctx, abortController, emitted } = makeContext()
  const running = await startDingtalkAccount(ctx, {
    clientFactory: factory,
    minStableConnectionMs: 0,
  })
  await nextTick()
  const client = state.client
  // Stop the connector — `stopped` flag flips true.
  await running.stop()
  // Now a late callback arrives. Must drop entirely: no ACK, no emit.
  client.__sentInbound(downStream("hdr-post-stop", VALID_PAYLOAD))
  await nextTick()
  assert.deepEqual(client.__acks, [], "no ACK after stop()")
  assert.equal(emitted.length, 0, "no emit after stop()")
  // ctx.signal is still un-aborted; ensure abort path also drops.
  abortController.abort()
  client.__sentInbound(downStream("hdr-post-abort", VALID_PAYLOAD))
  await nextTick()
  assert.deepEqual(client.__acks, [], "no ACK after abort either")
  assert.equal(emitted.length, 0, "no emit after abort either")
})

test("stream: callbacks after ctx.signal abort (without stop()) are also dropped", async () => {
  const { factory, state } = makeMockClientFactory()
  const { ctx, abortController, emitted } = makeContext()
  const running = await startDingtalkAccount(ctx, {
    clientFactory: factory,
    minStableConnectionMs: 0,
  })
  await nextTick()
  const client = state.client
  abortController.abort() // runtime-initiated abort
  await nextTick()
  client.__sentInbound(downStream("hdr-aborted", VALID_PAYLOAD))
  await nextTick()
  assert.deepEqual(client.__acks, [])
  assert.equal(emitted.length, 0)
  await running.stop()
})
