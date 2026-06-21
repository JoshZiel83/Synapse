import test from "node:test"
import assert from "node:assert/strict"
import { DisconnectReason } from "baileys"
import { buildManagedAuthState } from "./auth-state.js"
import { type AuthSnapshot } from "./creds-persistence.js"
import {
  getWhatsappLoginSession,
  startWhatsappLoginSession,
} from "./login-qr.js"
import { setRedisForTest, type LoginSessionRedis } from "./qr-session-store.js"
import {
  isSessionPaused,
  pauseSessionOperator,
  setRedisForTest as setGuardRedisForTest,
  type SessionGuardRedis,
} from "./session-guard.js"

// In-memory redis for the session-guard (verifies the on-link pause clear).
class GuardRedis implements SessionGuardRedis {
  store = new Map<string, string>()
  async set(k: string, v: string) {
    this.store.set(k, v)
    return "OK"
  }
  async get(k: string) {
    return this.store.get(k) ?? null
  }
  async del(k: string) {
    return this.store.delete(k) ? 1 : 0
  }
  async ttl(k: string) {
    return this.store.has(k) ? 100 : -2
  }
  async exists(k: string) {
    return this.store.has(k) ? 1 : 0
  }
}

function boomError(statusCode: number): Error {
  return { output: { statusCode } } as unknown as Error
}

class FakeRedis implements LoginSessionRedis {
  store = new Map<string, string>()
  async set(k: string, v: string) {
    this.store.set(k, v)
    return "OK"
  }
  async get(k: string) {
    return this.store.get(k) ?? null
  }
  async del(k: string) {
    return this.store.delete(k) ? 1 : 0
  }
}

type Listener = (arg: unknown) => void
function makeLoginSocket(snapshot: AuthSnapshot) {
  const managedAuth = buildManagedAuthState(snapshot)
  const listeners: Listener[] = []
  const socket = {
    ev: {
      on(event: string, cb: Listener) {
        if (event === "connection.update") listeners.push(cb)
      },
    },
    end() {},
    async requestPairingCode() {
      return "ABCD-1234"
    },
  }
  const emit = (arg: unknown) => listeners.forEach((cb) => cb(arg))
  return { socket, managedAuth, emit }
}

function tick(ms = 20): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

test("QR login: real first-pair sequence (isNewLogin) links + persists + clears stale pause", async () => {
  const restore = setRedisForTest(new FakeRedis())
  const guard = new GuardRedis()
  const restoreGuard = setGuardRedisForTest(guard)
  const box: { current: ReturnType<typeof makeLoginSocket> | null } = {
    current: null,
  }
  const persistCalls: Array<Record<string, unknown>> = []

  const session = await startWhatsappLoginSession(
    { workspaceId: "ws1", displayName: "My WA" },
    {
      socketFactory: ((snap: AuthSnapshot) => {
        box.current = makeLoginSocket(snap)
        return box.current as never
      }) as never,
      renderQr: async (qr) =>
        `data:image/png;base64,${Buffer.from(qr).toString("base64")}`,
      persistAccount: (async (p: Record<string, unknown>) => {
        persistCalls.push(p)
        return { id: "acc-new" }
      }) as never,
      refreshRuntime: (async () => {}) as never,
    }
  )

  assert.equal(session.status, "pending")
  await tick()

  // Simulate a stale auto-pause left from a prior wipe — WU-3 must clear it.
  await pauseSessionOperator("acc-new", 99999)
  assert.equal(await isSessionPaused("acc-new"), true)

  // QR arrives
  box.current!.emit({ qr: "2@raw-qr-token" })
  await tick()
  let polled = await getWhatsappLoginSession({
    workspaceId: "ws1",
    sessionId: session.sessionId,
  })
  assert.equal(polled?.status, "qr")
  assert.ok(polled?.qrDataUrl?.startsWith("data:image/png;base64,"))

  // REAL Baileys first-pair: creds become registered (flush) then {isNewLogin}.
  // The transient socket NEVER emits {connection:'open'} on a fresh pair.
  const creds = box.current!.managedAuth.getSnapshot().creds
  creds.registered = true
  creds.me = { id: "15551112222:5@s.whatsapp.net", name: "My WA" }
  box.current!.emit({ connection: "update", isNewLogin: true })
  await tick(60)

  polled = await getWhatsappLoginSession({
    workspaceId: "ws1",
    sessionId: session.sessionId,
  })
  assert.equal(polled?.status, "linked")
  assert.equal(polled?.transportAccountId, "acc-new")
  assert.equal(persistCalls.length, 1)
  // persisted with the normalized self-jid + accountKey derived from the number
  assert.equal(persistCalls[0].accountKey, "15551112222")
  assert.equal(persistCalls[0].selfJid, "15551112222@s.whatsapp.net")
  // WU-3: the stale pause flag is cleared on a successful re-link.
  assert.equal(await isSessionPaused("acc-new"), false)
  restoreGuard()
  restore()
})

test("QR login: a 515 restartRequired close AFTER registration links (not error)", async () => {
  const restore = setRedisForTest(new FakeRedis())
  const restoreGuard = setGuardRedisForTest(new GuardRedis())
  const box: { current: ReturnType<typeof makeLoginSocket> | null } = {
    current: null,
  }
  const persistCalls: Array<Record<string, unknown>> = []

  const session = await startWhatsappLoginSession(
    { workspaceId: "ws1", displayName: "My WA" },
    {
      socketFactory: ((snap: AuthSnapshot) => {
        box.current = makeLoginSocket(snap)
        return box.current as never
      }) as never,
      renderQr: async (qr) => qr,
      persistAccount: (async (p: Record<string, unknown>) => {
        persistCalls.push(p)
        return { id: "acc-515" }
      }) as never,
      refreshRuntime: (async () => {}) as never,
    }
  )

  await tick()
  const creds = box.current!.managedAuth.getSnapshot().creds
  creds.registered = true
  creds.me = { id: "15551112222:5@s.whatsapp.net", name: "My WA" }
  // The server forces a restart → a close with statusCode 515 (restartRequired).
  box.current!.emit({
    connection: "close",
    lastDisconnect: { error: boomError(DisconnectReason.restartRequired) },
  })
  await tick(60)

  const polled = await getWhatsappLoginSession({
    workspaceId: "ws1",
    sessionId: session.sessionId,
  })
  assert.equal(polled?.status, "linked")
  assert.equal(persistCalls.length, 1)
  restoreGuard()
  restore()
})

test("pairing-code login: requests a code when phoneNumberE164 is set", async () => {
  const restore = setRedisForTest(new FakeRedis())
  const box: { current: ReturnType<typeof makeLoginSocket> | null } = {
    current: null,
  }

  const session = await startWhatsappLoginSession(
    { workspaceId: "ws1", phoneNumberE164: "+1 555 111 2222" },
    {
      socketFactory: ((snap: AuthSnapshot) => {
        box.current = makeLoginSocket(snap)
        return box.current as never
      }) as never,
      renderQr: async (qr) => qr,
      persistAccount: (async () => ({ id: "acc" })) as never,
      refreshRuntime: (async () => {}) as never,
    }
  )

  await tick()
  box.current!.emit({ connection: "connecting" })
  await tick()

  const polled = await getWhatsappLoginSession({
    workspaceId: "ws1",
    sessionId: session.sessionId,
  })
  assert.equal(polled?.status, "pairing")
  assert.equal(polled?.pairingCode, "ABCD-1234")
  restore()
})

test("a non-restart close before registration flips the session to error", async () => {
  const restore = setRedisForTest(new FakeRedis())
  const box: { current: ReturnType<typeof makeLoginSocket> | null } = {
    current: null,
  }
  const persistCalls: number[] = []

  const session = await startWhatsappLoginSession(
    { workspaceId: "ws1" },
    {
      socketFactory: ((snap: AuthSnapshot) => {
        box.current = makeLoginSocket(snap)
        return box.current as never
      }) as never,
      renderQr: async (qr) => qr,
      persistAccount: (async () => {
        persistCalls.push(1)
        return { id: "acc" }
      }) as never,
      refreshRuntime: (async () => {}) as never,
    }
  )

  await tick()
  // A connectionClosed (428) close BEFORE creds are registered = a real failure.
  box.current!.emit({
    connection: "close",
    lastDisconnect: { error: boomError(DisconnectReason.connectionClosed) },
  })
  await tick()

  const polled = await getWhatsappLoginSession({
    workspaceId: "ws1",
    sessionId: session.sessionId,
  })
  assert.equal(polled?.status, "error")
  assert.equal(
    persistCalls.length,
    0,
    "no persist on a pre-registration failure"
  )
  restore()
})

test("flush race: open before creds register, then late registration → linked", async () => {
  const restore = setRedisForTest(new FakeRedis())
  const restoreGuard = setGuardRedisForTest(new GuardRedis())
  const box: { current: ReturnType<typeof makeLoginSocket> | null } = {
    current: null,
  }
  const persistCalls: number[] = []

  const session = await startWhatsappLoginSession(
    { workspaceId: "ws1", displayName: "Late WA" },
    {
      credsFlushTimeoutMs: 1_000,
      socketFactory: ((snap: AuthSnapshot) => {
        box.current = makeLoginSocket(snap)
        return box.current as never
      }) as never,
      renderQr: async (qr) => qr,
      persistAccount: (async () => {
        persistCalls.push(1)
        return { id: "acc-late" }
      }) as never,
      refreshRuntime: (async () => {}) as never,
    }
  )

  await tick()
  // open fires while creds are NOT yet registered (the masked race).
  box.current!.emit({ connection: "open" })
  await tick(20)
  // still pending — onPaired is polling waitForRegisteredCreds.
  let polled = await getWhatsappLoginSession({
    workspaceId: "ws1",
    sessionId: session.sessionId,
  })
  assert.notEqual(polled?.status, "linked")

  // creds register LATE — the poll should pick them up and link.
  const creds = box.current!.managedAuth.getSnapshot().creds
  creds.registered = true
  creds.me = { id: "15551112222@s.whatsapp.net", name: "Late WA" }
  await tick(300)

  polled = await getWhatsappLoginSession({
    workspaceId: "ws1",
    sessionId: session.sessionId,
  })
  assert.equal(polled?.status, "linked")
  assert.equal(persistCalls.length, 1)
  restoreGuard()
  restore()
})

test("flush race: creds never register within the timeout → error, persist NOT called", async () => {
  const restore = setRedisForTest(new FakeRedis())
  const restoreGuard = setGuardRedisForTest(new GuardRedis())
  const box: { current: ReturnType<typeof makeLoginSocket> | null } = {
    current: null,
  }
  const persistCalls: number[] = []

  const session = await startWhatsappLoginSession(
    { workspaceId: "ws1" },
    {
      credsFlushTimeoutMs: 200,
      socketFactory: ((snap: AuthSnapshot) => {
        box.current = makeLoginSocket(snap)
        return box.current as never
      }) as never,
      renderQr: async (qr) => qr,
      persistAccount: (async () => {
        persistCalls.push(1)
        return { id: "acc-never" }
      }) as never,
      refreshRuntime: (async () => {}) as never,
    }
  )

  await tick()
  box.current!.emit({ connection: "open" }) // creds never register
  await tick(400)

  const polled = await getWhatsappLoginSession({
    workspaceId: "ws1",
    sessionId: session.sessionId,
  })
  assert.equal(polled?.status, "error")
  assert.match(String(polled?.errorMessage), /creds not flushed/)
  assert.equal(
    persistCalls.length,
    0,
    "persist must NOT run on a flush timeout"
  )
  restoreGuard()
  restore()
})
