import test from "node:test"
import assert from "node:assert/strict"
import {
  defaultQqInteractionHandlerDeps,
  handleQqInteractionCreate,
  type QqInteractionCreateData,
  type QqInteractionHandlerDeps,
} from "./interaction-handler.js"
import type { TransportAccountSummary } from "@synapse/shared/types"
import type { ConnectorLogger } from "../types.js"

const ACCOUNT: TransportAccountSummary = {
  id: "acc-1",
  workspaceId: "ws-1",
  transportKind: "qq",
  accountKey: "k",
  displayName: "qq",
  ownerScope: "workspace",
  connectionMode: "long_connection",
  status: "active",
  credentials: { appId: "A", clientSecret: "S" },
  config: {},
  metadata: {},
  inboundActorMode: "none",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
} as unknown as TransportAccountSummary

function makeLogger(): ConnectorLogger & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    debug(msg) {
      lines.push(`debug ${msg}`)
    },
    info(msg) {
      lines.push(`info ${msg}`)
    },
    warn(msg) {
      lines.push(`warn ${msg}`)
    },
    error(msg) {
      lines.push(`error ${msg}`)
    },
  }
}

function makeDeps(
  overrides: Partial<QqInteractionHandlerDeps> = {}
): QqInteractionHandlerDeps & {
  acks: Array<{ eventId: string; code: number }>
  resolves: number
} {
  const acks: Array<{ eventId: string; code: number }> = []
  let resolves = 0
  const real = defaultQqInteractionHandlerDeps()
  const deps: QqInteractionHandlerDeps & {
    acks: typeof acks
    resolves: number
  } = {
    ...real,
    ackInteraction: async (p) => {
      acks.push({ eventId: p.eventId, code: p.code })
    },
    lookupActionToken: overrides.lookupActionToken ?? real.lookupActionToken,
    resolveInteractionRequest: overrides.resolveInteractionRequest
      ? async (p) => {
          resolves += 1
          return overrides.resolveInteractionRequest!(p)
        }
      : real.resolveInteractionRequest,
    getTaskSummary: overrides.getTaskSummary ?? real.getTaskSummary,
    getTransportAddressByExternalId:
      overrides.getTransportAddressByExternalId ??
      real.getTransportAddressByExternalId,
    syncTransportAddressConversationParticipant:
      overrides.syncTransportAddressConversationParticipant ??
      real.syncTransportAddressConversationParticipant,
    get acks() {
      return acks
    },
    get resolves() {
      return resolves
    },
  }
  return deps
}

test("handleQqInteractionCreate: missing event id → no-op", async () => {
  const deps = makeDeps()
  const logger = makeLogger()
  await handleQqInteractionCreate({
    account: ACCOUNT,
    data: {} as QqInteractionCreateData,
    logger,
    deps,
  })
  assert.equal(deps.acks.length, 0)
})

test("handleQqInteractionCreate: non-synapse button → ack code 0 + skip", async () => {
  const deps = makeDeps({
    lookupActionToken: async () => null,
  })
  const logger = makeLogger()
  await handleQqInteractionCreate({
    account: ACCOUNT,
    data: {
      id: "evt-1",
      data: { resolved: { button_data: "other-bot:xyz" } },
    },
    logger,
    deps,
  })
  assert.equal(deps.acks.length, 1)
  assert.equal(deps.acks[0]!.code, 0)
  assert.equal(deps.resolves, 0)
})

test("handleQqInteractionCreate: expired action token → ack only", async () => {
  const deps = makeDeps({
    lookupActionToken: async () => null,
  })
  const logger = makeLogger()
  await handleQqInteractionCreate({
    account: ACCOUNT,
    data: {
      id: "evt-2",
      data: { resolved: { button_data: "synapse-interaction:tok-x" } },
      user_openid: "U1",
    },
    logger,
    deps,
  })
  assert.equal(deps.acks.length, 1)
  assert.equal(deps.resolves, 0)
})

test("handleQqInteractionCreate: unbound clicker → ack only, no resolve", async () => {
  const deps = makeDeps({
    lookupActionToken: async () => ({
      token: "tok-x",
      interactionRequestId: "ir-1",
      payload: { decision: "approve", preset: "once" },
      expiresAt: new Date(Date.now() + 60_000),
    }),
    getTransportAddressByExternalId: async () => undefined,
  })
  const logger = makeLogger()
  await handleQqInteractionCreate({
    account: ACCOUNT,
    data: {
      id: "evt-3",
      data: { resolved: { button_data: "synapse-interaction:tok-x" } },
      user_openid: "U1",
    },
    logger,
    deps,
  })
  assert.equal(deps.acks.length, 1)
  assert.equal(deps.resolves, 0)
})

test("handleQqInteractionCreate: happy approve path → resolve + ack", async () => {
  const calls: Array<{ decision: string; preset?: string; commandId: string }> =
    []
  const deps = makeDeps({
    lookupActionToken: async () => ({
      token: "tok-x",
      interactionRequestId: "ir-42",
      payload: {
        decision: "approve",
        preset: "once",
        selectedGrantOptionId: "primary",
      },
      expiresAt: new Date(Date.now() + 60_000),
    }),
    getTransportAddressByExternalId: async () =>
      ({
        id: "addr-1",
        workspace_id: "ws-1",
        transport_account_id: "acc-1",
        transport_kind: "qq",
        address_type: "user",
        external_id: "c2c:U1",
        display_name: null,
        workspace_member_id: "wm-1",
        metadata: {},
        created_at: new Date(),
        updated_at: new Date(),
      }) as any,
    getTaskSummary: async () =>
      ({
        id: "ir-42",
        workspaceId: "ws-1",
        conversationId: "conv-1",
        kind: "runtime_authorization",
        status: "pending",
        revision: 1,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        viewerCanResolve: true,
      }) as any,
    syncTransportAddressConversationParticipant: async () =>
      ({ id: "participant-1" }) as any,
    resolveInteractionRequest: async (p) => {
      calls.push({
        decision: (p as any).decision,
        preset: (p as any).preset,
        commandId: p.commandId,
      })
      return {
        outcome: "applied",
        interaction: { id: "ir-42" } as any,
        createdGrant: undefined,
      }
    },
  })
  const logger = makeLogger()
  await handleQqInteractionCreate({
    account: ACCOUNT,
    data: {
      id: "qq-event-1",
      data: { resolved: { button_data: "synapse-interaction:tok-x" } },
      user_openid: "U1",
    },
    logger,
    deps,
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.decision, "approve")
  assert.equal(calls[0]!.preset, "once")
  // Deterministic commandId — re-running with the same triple yields the same UUID.
  const firstCommandId = calls[0]!.commandId
  assert.match(firstCommandId, /^[0-9a-f-]+$/i)
  assert.equal(deps.acks.length, 1)
  assert.equal(deps.acks[0]!.code, 0)
})

test("handleQqInteractionCreate: same event replayed → same commandId (deterministic)", async () => {
  const allCommandIds: string[] = []
  function build() {
    return makeDeps({
      lookupActionToken: async () => ({
        token: "tok-y",
        interactionRequestId: "ir-99",
        payload: { decision: "approve", preset: "once" },
        expiresAt: new Date(Date.now() + 60_000),
      }),
      getTransportAddressByExternalId: async () =>
        ({
          id: "addr",
          workspace_member_id: "wm",
        }) as any,
      getTaskSummary: async () =>
        ({
          id: "ir-99",
          workspaceId: "ws-1",
          conversationId: "conv-1",
          kind: "runtime_authorization",
          status: "pending",
          revision: 1,
        }) as any,
      syncTransportAddressConversationParticipant: async () =>
        ({ id: "p" }) as any,
      resolveInteractionRequest: async (p) => {
        allCommandIds.push(p.commandId)
        return {
          outcome: "applied",
          interaction: { id: "ir-99" } as any,
        }
      },
    })
  }
  const logger = makeLogger()
  for (let i = 0; i < 2; i++) {
    await handleQqInteractionCreate({
      account: ACCOUNT,
      data: {
        id: "qq-evt-determine",
        data: { resolved: { button_data: "synapse-interaction:tok-y" } },
        user_openid: "U1",
      },
      logger,
      deps: build(),
    })
  }
  assert.equal(allCommandIds.length, 2)
  assert.equal(allCommandIds[0], allCommandIds[1])
})

test("handleQqInteractionCreate: group event composes gm: clicker id", async () => {
  let seenExternalId = ""
  const deps = makeDeps({
    lookupActionToken: async () => ({
      token: "tok-g",
      interactionRequestId: "ir-g",
      payload: { decision: "reject" },
      expiresAt: new Date(Date.now() + 60_000),
    }),
    getTransportAddressByExternalId: async (p) => {
      seenExternalId = p.externalId
      return undefined
    },
  })
  const logger = makeLogger()
  await handleQqInteractionCreate({
    account: ACCOUNT,
    data: {
      id: "evt-g",
      data: { resolved: { button_data: "synapse-interaction:tok-g" } },
      group_openid: "GRP",
      group_member_openid: "MEM",
    },
    logger,
    deps,
  })
  assert.equal(seenExternalId, "gm:GRP:MEM")
})

test("handleQqInteractionCreate: transient resolve error → do NOT ack (user retries)", async () => {
  const deps = makeDeps({
    lookupActionToken: async () => ({
      token: "tok-z",
      interactionRequestId: "ir-z",
      payload: { decision: "approve", preset: "once" },
      expiresAt: new Date(Date.now() + 60_000),
    }),
    getTransportAddressByExternalId: async () =>
      ({ id: "addr", workspace_member_id: "wm" }) as any,
    getTaskSummary: async () =>
      ({
        id: "ir-z",
        workspaceId: "ws-1",
        conversationId: "conv-z",
        kind: "runtime_authorization",
        status: "pending",
        revision: 1,
      }) as any,
    syncTransportAddressConversationParticipant: async () =>
      ({ id: "p" }) as any,
    resolveInteractionRequest: async () => {
      throw new Error("connection pool exhausted")
    },
  })
  const logger = makeLogger()
  await handleQqInteractionCreate({
    account: ACCOUNT,
    data: {
      id: "evt-tx",
      data: { resolved: { button_data: "synapse-interaction:tok-z" } },
      user_openid: "U1",
    },
    logger,
    deps,
  })
  assert.equal(deps.acks.length, 0)
})

test("handleQqInteractionCreate: permanent resolve error → ack + drop", async () => {
  const deps = makeDeps({
    lookupActionToken: async () => ({
      token: "tok-p",
      interactionRequestId: "ir-p",
      payload: { decision: "approve", preset: "once" },
      expiresAt: new Date(Date.now() + 60_000),
    }),
    getTransportAddressByExternalId: async () =>
      ({ id: "addr", workspace_member_id: "wm" }) as any,
    getTaskSummary: async () =>
      ({
        id: "ir-p",
        workspaceId: "ws-1",
        conversationId: "conv-p",
        kind: "runtime_authorization",
        status: "pending",
        revision: 1,
      }) as any,
    syncTransportAddressConversationParticipant: async () =>
      ({ id: "p" }) as any,
    resolveInteractionRequest: async () => {
      throw new Error("Interaction request not found")
    },
  })
  const logger = makeLogger()
  await handleQqInteractionCreate({
    account: ACCOUNT,
    data: {
      id: "evt-perm",
      data: { resolved: { button_data: "synapse-interaction:tok-p" } },
      user_openid: "U1",
    },
    logger,
    deps,
  })
  assert.equal(deps.acks.length, 1)
  assert.equal(deps.acks[0]!.code, 0)
})
