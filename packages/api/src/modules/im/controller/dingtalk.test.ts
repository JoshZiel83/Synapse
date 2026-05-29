/**
 * Controller handler tests.
 *
 * Tests handleStartDeviceFlow / handlePollDeviceFlow against a fake
 * provider + injected SessionStore (in-memory) + injected persist /
 * getAccount. No real Redis or DB involvement.
 */

import test from "node:test"
import assert from "node:assert/strict"
import type {
  RegistrationPollResult,
  RegistrationProvider,
} from "../connectors/dingtalk/device-registration.js"
import {
  RegistrationBusinessError,
  RegistrationTransientError,
} from "../connectors/dingtalk/device-registration.js"
import { __test as controllerHandlers } from "./dingtalk.js"
import type { DingtalkRegistrationSession } from "../connectors/dingtalk/registration-session-store.js"

// ─────────── in-memory session store ───────────

interface SessionStore {
  get(
    workspaceId: string,
    sessionId: string
  ): Promise<DingtalkRegistrationSession | null>
  set(session: DingtalkRegistrationSession): Promise<void>
}

function makeMemoryStore(): SessionStore & {
  __dump: Map<string, DingtalkRegistrationSession>
} {
  const store = new Map<string, DingtalkRegistrationSession>()
  return {
    async get(workspaceId, sessionId) {
      return store.get(`${workspaceId}:${sessionId}`) ?? null
    },
    async set(session) {
      store.set(`${session.workspaceId}:${session.sessionId}`, session)
    },
    __dump: store,
  }
}

// ─────────── fake provider ───────────

interface FakeProviderCalls {
  init: number
  begin: number
  poll: number
}

function makeFakeProvider(behaviour: {
  beginThrow?: Error
  initThrow?: Error
  pollResults?: RegistrationPollResult[]
  pollThrows?: Error[]
}): { provider: RegistrationProvider; calls: FakeProviderCalls } {
  const calls: FakeProviderCalls = { init: 0, begin: 0, poll: 0 }
  let pollIdx = 0
  return {
    provider: {
      kind: "openclaw",
      async init() {
        calls.init += 1
        if (behaviour.initThrow) throw behaviour.initThrow
        return { nonce: "nonce-1" }
      },
      async begin() {
        calls.begin += 1
        if (behaviour.beginThrow) throw behaviour.beginThrow
        return {
          deviceCode: "dc-1",
          userCode: "USR-1",
          verificationUri: "https://login.dingtalk.com/uc",
          verificationUriComplete: "https://login.dingtalk.com/uc?dc=1",
          expiresInSeconds: 600,
          intervalSeconds: 5,
        }
      },
      async poll() {
        calls.poll += 1
        const t = behaviour.pollThrows?.[pollIdx]
        const r = behaviour.pollResults?.[pollIdx]
        pollIdx += 1
        if (t) throw t
        return r ?? { status: "waiting" }
      },
    },
    calls,
  }
}

const { handleStartDeviceFlow, handlePollDeviceFlow } = controllerHandlers as {
  handleStartDeviceFlow: (
    workspaceId: string,
    input: {
      displayName: string
      ownerScope: "workspace" | "workspace_member"
      ownerWorkspaceMemberId: string | null
      inboundActorMode?: "follow_owner_chief_actor" | "none" | "specified_actor"
      inboundActorId?: string | null
    },
    deps: {
      provider: RegistrationProvider | null
      nowMs?: () => number
      generateSessionId?: () => string
      getAccountById?: (id: string) => Promise<unknown>
      sessionStore?: SessionStore
    }
  ) => Promise<
    | {
        providerStartFailed: false
        session: {
          sessionId: string
          status: string
          verificationUriComplete: string
        }
      }
    | { providerStartFailed: true; error: string }
  >
  handlePollDeviceFlow: (
    workspaceId: string,
    sessionId: string,
    deps: {
      provider: RegistrationProvider | null
      nowMs?: () => number
      getAccountById?: (id: string) => Promise<unknown>
      persistAccount?: (input: unknown) => Promise<{ id: string }>
      sessionStore?: SessionStore
    }
  ) => Promise<{
    status: number
    body:
      | {
          session: {
            status: string
            message?: string
            transportAccount?: { id: string }
          }
        }
      | { error: string }
  }>
}

// ─────────── start tests ───────────

test("controller.start: success returns providerStartFailed:false + session summary", async () => {
  const store = makeMemoryStore()
  const { provider } = makeFakeProvider({})
  const result = await handleStartDeviceFlow(
    "ws-1",
    {
      displayName: "DingBot",
      ownerScope: "workspace",
      ownerWorkspaceMemberId: null,
    },
    {
      provider,
      sessionStore: store,
      generateSessionId: () => "sess-1",
      nowMs: () => 1700000000000,
      getAccountById: async () => null,
    }
  )
  assert.equal(result.providerStartFailed, false)
  if (result.providerStartFailed === false) {
    assert.equal(result.session.sessionId, "sess-1")
    assert.equal(result.session.status, "waiting")
    assert.equal(
      result.session.verificationUriComplete,
      "https://login.dingtalk.com/uc?dc=1"
    )
  }
})

test("controller.start: init RegistrationBusinessError → providerStartFailed:true (no session created)", async () => {
  const store = makeMemoryStore()
  const { provider } = makeFakeProvider({
    initThrow: new RegistrationBusinessError("source disabled", 88001),
  })
  const result = await handleStartDeviceFlow(
    "ws-1",
    {
      displayName: "DingBot",
      ownerScope: "workspace",
      ownerWorkspaceMemberId: null,
    },
    {
      provider,
      sessionStore: store,
      generateSessionId: () => "sess-1",
      getAccountById: async () => null,
    }
  )
  assert.equal(result.providerStartFailed, true)
  if (result.providerStartFailed) {
    assert.match(result.error, /source disabled/)
  }
  assert.equal(store.__dump.size, 0)
})

test("controller.start: begin RegistrationBusinessError → providerStartFailed:true", async () => {
  const store = makeMemoryStore()
  const { provider } = makeFakeProvider({
    beginThrow: new RegistrationBusinessError("no quota"),
  })
  const result = await handleStartDeviceFlow(
    "ws-1",
    {
      displayName: "DingBot",
      ownerScope: "workspace",
      ownerWorkspaceMemberId: null,
    },
    { provider, sessionStore: store, getAccountById: async () => null }
  )
  assert.equal(result.providerStartFailed, true)
  assert.equal(store.__dump.size, 0)
})

test("controller.start: init RegistrationTransientError → providerStartFailed:true (no 5xx)", async () => {
  const store = makeMemoryStore()
  const { provider } = makeFakeProvider({
    initThrow: new RegistrationTransientError("ECONNRESET"),
  })
  const result = await handleStartDeviceFlow(
    "ws-1",
    {
      displayName: "DingBot",
      ownerScope: "workspace",
      ownerWorkspaceMemberId: null,
    },
    { provider, sessionStore: store, getAccountById: async () => null }
  )
  assert.equal(result.providerStartFailed, true)
})

test("controller.start: provider==null → providerStartFailed:true (disabled mode)", async () => {
  const store = makeMemoryStore()
  const result = await handleStartDeviceFlow(
    "ws-1",
    {
      displayName: "DingBot",
      ownerScope: "workspace",
      ownerWorkspaceMemberId: null,
    },
    { provider: null, sessionStore: store, getAccountById: async () => null }
  )
  assert.equal(result.providerStartFailed, true)
  if (result.providerStartFailed) {
    assert.match(result.error, /disabled/)
  }
})

// ─────────── poll tests ───────────

const FRESH_SESSION: DingtalkRegistrationSession = {
  sessionId: "sess-poll",
  workspaceId: "ws-1",
  deviceCode: "dc-1",
  userCode: "USR-1",
  verificationUri: "https://login.dingtalk.com/uc",
  verificationUriComplete: "https://login.dingtalk.com/uc?dc=1",
  expiresInSeconds: 600,
  intervalSeconds: 5,
  expiresAt: 2_000_000_000_000,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  status: "waiting",
  providerFailureCount: 0,
}

function seedSession(
  store: { __dump: Map<string, DingtalkRegistrationSession> },
  patch: Partial<DingtalkRegistrationSession> = {}
): void {
  const session: DingtalkRegistrationSession = {
    ...FRESH_SESSION,
    pendingForm: {
      displayName: "DingBot",
      ownerScope: "workspace",
      ownerWorkspaceMemberId: null,
      inboundActorMode: "none",
      inboundActorId: null,
    },
    ...patch,
  }
  store.__dump.set(`${session.workspaceId}:${session.sessionId}`, session)
}

test("controller.poll: 404 when session missing", async () => {
  const store = makeMemoryStore()
  const { provider } = makeFakeProvider({})
  const out = await handlePollDeviceFlow("ws-1", "missing", {
    provider,
    sessionStore: store,
    getAccountById: async () => null,
  })
  assert.equal(out.status, 404)
})

test("controller.poll: waiting status returns {session}", async () => {
  const store = makeMemoryStore()
  seedSession(store)
  const { provider } = makeFakeProvider({
    pollResults: [{ status: "waiting" }],
  })
  const out = await handlePollDeviceFlow("ws-1", "sess-poll", {
    provider,
    sessionStore: store,
    nowMs: () => 1_700_000_001_000,
    getAccountById: async () => null,
  })
  assert.equal(out.status, 200)
  assert.ok("session" in out.body)
  if ("session" in out.body) {
    assert.equal(out.body.session.status, "waiting")
  }
})

test("controller.poll: SUCCESS triggers persist + writes transportAccount on summary", async () => {
  const store = makeMemoryStore()
  seedSession(store)
  let persistCalls = 0
  const persist = async (input: unknown) => {
    persistCalls += 1
    const i = input as { clientId: string; displayName: string }
    assert.equal(i.clientId, "ding-new")
    assert.equal(i.displayName, "DingBot")
    return { id: "acc-success-1" }
  }
  const getAccountById = async (id: string) =>
    id === "acc-success-1" ? ({ id, displayName: "DingBot" } as unknown) : null
  const { provider } = makeFakeProvider({
    pollResults: [
      { status: "success", clientId: "ding-new", clientSecret: "secret-new" },
    ],
  })
  const out = await handlePollDeviceFlow("ws-1", "sess-poll", {
    provider,
    sessionStore: store,
    nowMs: () => 1_700_000_001_000,
    persistAccount: persist,
    getAccountById,
  })
  assert.equal(out.status, 200)
  assert.equal(persistCalls, 1)
  if ("session" in out.body) {
    assert.equal(out.body.session.status, "success")
    assert.equal(out.body.session.transportAccount?.id, "acc-success-1")
  }

  // Second poll on the same SUCCESS session must short-circuit.
  const out2 = await handlePollDeviceFlow("ws-1", "sess-poll", {
    provider,
    sessionStore: store,
    nowMs: () => 1_700_000_002_000,
    persistAccount: persist,
    getAccountById,
  })
  assert.equal(persistCalls, 1, "persist must not be called twice")
  if ("session" in out2.body) {
    assert.equal(out2.body.session.status, "success")
  }
})

test("controller.poll: RegistrationBusinessError flips session to fail (HTTP 200 + status fail)", async () => {
  const store = makeMemoryStore()
  seedSession(store)
  const { provider } = makeFakeProvider({
    pollThrows: [new RegistrationBusinessError("source disabled", 88001)],
  })
  const out = await handlePollDeviceFlow("ws-1", "sess-poll", {
    provider,
    sessionStore: store,
    getAccountById: async () => null,
  })
  assert.equal(out.status, 200)
  if ("session" in out.body) {
    assert.equal(out.body.session.status, "fail")
    assert.match(out.body.session.message ?? "", /source disabled/)
  }
})

test("controller.poll: RegistrationTransientError 1-4 → 502, providerFailureCount accumulates", async () => {
  const store = makeMemoryStore()
  seedSession(store)
  const { provider } = makeFakeProvider({
    pollThrows: [
      new RegistrationTransientError("ECONNRESET 1"),
      new RegistrationTransientError("ECONNRESET 2"),
      new RegistrationTransientError("ECONNRESET 3"),
      new RegistrationTransientError("ECONNRESET 4"),
    ],
  })
  for (let i = 1; i <= 4; i++) {
    const out = await handlePollDeviceFlow("ws-1", "sess-poll", {
      provider,
      sessionStore: store,
      getAccountById: async () => null,
    })
    assert.equal(out.status, 502, `attempt ${i} should be 502`)
  }
  const stored = store.__dump.get("ws-1:sess-poll")!
  assert.equal(stored.providerFailureCount, 4)
  assert.equal(stored.status, "waiting")
})

test("controller.poll: RegistrationTransientError 5th flips to fail (HTTP 200)", async () => {
  const store = makeMemoryStore()
  seedSession(store, { providerFailureCount: 4 })
  const { provider } = makeFakeProvider({
    pollThrows: [new RegistrationTransientError("ECONNRESET 5")],
  })
  const out = await handlePollDeviceFlow("ws-1", "sess-poll", {
    provider,
    sessionStore: store,
    getAccountById: async () => null,
  })
  assert.equal(out.status, 200)
  if ("session" in out.body) {
    assert.equal(out.body.session.status, "fail")
    assert.match(out.body.session.message ?? "", /unreachable/)
  }
})

test("controller.poll: successful poll resets providerFailureCount", async () => {
  const store = makeMemoryStore()
  seedSession(store, { providerFailureCount: 3 })
  const { provider } = makeFakeProvider({
    pollResults: [{ status: "waiting" }],
  })
  await handlePollDeviceFlow("ws-1", "sess-poll", {
    provider,
    sessionStore: store,
    getAccountById: async () => null,
  })
  const stored = store.__dump.get("ws-1:sess-poll")!
  assert.equal(stored.providerFailureCount, 0)
})

test("controller.poll: past expiresAt flips to 'expired' (grace window)", async () => {
  const store = makeMemoryStore()
  seedSession(store, { expiresAt: 1_700_000_000_000 })
  const { provider, calls } = makeFakeProvider({})
  const out = await handlePollDeviceFlow("ws-1", "sess-poll", {
    provider,
    sessionStore: store,
    nowMs: () => 1_700_000_500_000,
    getAccountById: async () => null,
  })
  assert.equal(out.status, 200)
  if ("session" in out.body) {
    assert.equal(out.body.session.status, "expired")
  }
  assert.equal(calls.poll, 0)
})

test("controller.poll: terminal status short-circuits without provider call", async () => {
  const store = makeMemoryStore()
  seedSession(store, { status: "fail", message: "user denied" })
  const { provider, calls } = makeFakeProvider({})
  const out = await handlePollDeviceFlow("ws-1", "sess-poll", {
    provider,
    sessionStore: store,
    getAccountById: async () => null,
  })
  assert.equal(out.status, 200)
  assert.equal(calls.poll, 0)
  if ("session" in out.body) {
    assert.equal(out.body.session.status, "fail")
  }
})

test("controller.poll: SUCCESS branch redacts deviceCode in the stored session", async () => {
  // The Redis row hangs around for the grace window so re-polls return
  // the terminal summary; the auth secret must not sit alongside it.
  const store = makeMemoryStore()
  seedSession(store, { deviceCode: "dc-secret" })
  const persist = async () => ({ id: "acc-success-1" })
  const getAccountById = async (id: string) =>
    id === "acc-success-1" ? ({ id, displayName: "DingBot" } as unknown) : null
  const { provider } = makeFakeProvider({
    pollResults: [
      { status: "success", clientId: "ding-new", clientSecret: "secret-new" },
    ],
  })
  await handlePollDeviceFlow("ws-1", "sess-poll", {
    provider,
    sessionStore: store,
    persistAccount: persist,
    getAccountById,
  })
  const stored = store.__dump.get("ws-1:sess-poll")
  assert.ok(stored)
  assert.equal(stored.status, "success")
  assert.equal(stored.deviceCode, "")
})

test("controller.poll: business-error branch also redacts deviceCode", async () => {
  const store = makeMemoryStore()
  seedSession(store, { deviceCode: "dc-secret" })
  const { provider } = makeFakeProvider({
    pollThrows: [new RegistrationBusinessError("source disabled", 88001)],
  })
  await handlePollDeviceFlow("ws-1", "sess-poll", {
    provider,
    sessionStore: store,
    getAccountById: async () => null,
  })
  const stored = store.__dump.get("ws-1:sess-poll")!
  assert.equal(stored.status, "fail")
  assert.equal(stored.deviceCode, "")
})

test("controller.poll: expired branch redacts deviceCode", async () => {
  const store = makeMemoryStore()
  seedSession(store, {
    expiresAt: 1_700_000_000_000,
    deviceCode: "dc-secret",
  })
  const { provider } = makeFakeProvider({})
  await handlePollDeviceFlow("ws-1", "sess-poll", {
    provider,
    sessionStore: store,
    nowMs: () => 1_700_000_500_000,
    getAccountById: async () => null,
  })
  const stored = store.__dump.get("ws-1:sess-poll")!
  assert.equal(stored.status, "expired")
  assert.equal(stored.deviceCode, "")
})

test("controller.poll: transient (still-waiting) branch KEEPS deviceCode (we need it for the next poll)", async () => {
  const store = makeMemoryStore()
  seedSession(store, { deviceCode: "dc-secret" })
  const { provider } = makeFakeProvider({
    pollThrows: [new RegistrationTransientError("ECONNRESET")],
  })
  await handlePollDeviceFlow("ws-1", "sess-poll", {
    provider,
    sessionStore: store,
    getAccountById: async () => null,
  })
  const stored = store.__dump.get("ws-1:sess-poll")!
  assert.equal(stored.status, "waiting")
  // Status is still waiting — next attempt will need deviceCode to poll.
  assert.equal(stored.deviceCode, "dc-secret")
})
