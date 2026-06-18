import test from "node:test"
import assert from "node:assert/strict"
import { buildManagedAuthState } from "./auth-state.js"
import { type AuthSnapshot } from "./creds-persistence.js"
import {
  getWhatsappLoginSession,
  startWhatsappLoginSession,
} from "./login-qr.js"
import { setRedisForTest, type LoginSessionRedis } from "./qr-session-store.js"

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

test("QR login: emits qr → data-URL, then links + persists on open", async () => {
  const restore = setRedisForTest(new FakeRedis())
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

  // QR arrives
  box.current!.emit({ qr: "2@raw-qr-token" })
  await tick()
  let polled = await getWhatsappLoginSession({
    workspaceId: "ws1",
    sessionId: session.sessionId,
  })
  assert.equal(polled?.status, "qr")
  assert.ok(polled?.qrDataUrl?.startsWith("data:image/png;base64,"))

  // mark creds registered (pairing completed) then emit open
  const creds = box.current!.managedAuth.getSnapshot().creds
  creds.registered = true
  creds.me = { id: "15551112222:5@s.whatsapp.net", name: "My WA" }
  box.current!.emit({ connection: "open" })
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

test("a close before open during login flips the session to error", async () => {
  const restore = setRedisForTest(new FakeRedis())
  const box: { current: ReturnType<typeof makeLoginSocket> | null } = {
    current: null,
  }

  const session = await startWhatsappLoginSession(
    { workspaceId: "ws1" },
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
  box.current!.emit({ connection: "close" })
  await tick()

  const polled = await getWhatsappLoginSession({
    workspaceId: "ws1",
    sessionId: session.sessionId,
  })
  assert.equal(polled?.status, "error")
  restore()
})
