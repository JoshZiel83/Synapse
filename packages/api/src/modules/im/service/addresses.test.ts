import test from "node:test"
import assert from "node:assert/strict"
import type { Executor } from "../../../infrastructure/database/kysely.js"
import {
  setTransportAddressLinkedUserUseCase,
  syncTransportAddressConversationParticipantUseCase,
} from "./addresses.js"

type SyncDeps = Parameters<
  typeof syncTransportAddressConversationParticipantUseCase
>[2]
type SetLinkedUserDeps = Parameters<
  typeof setTransportAddressLinkedUserUseCase
>[2]

function testAddress(overrides: Record<string, unknown> = {}) {
  return {
    id: "addr-1",
    workspaceId: "ws-1",
    transportAccountId: "acct-1",
    transportKind: "qq",
    addressType: "user",
    externalId: "external-1",
    displayName: "External One",
    workspaceMemberId: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Awaited<ReturnType<SyncDeps["getTransportAddressById"]>>
}

test("syncTransportAddressConversationParticipantUseCase threads one executor through participant sync", async () => {
  const queryable = { tx: "same" } as unknown as Executor
  const calls: string[] = []
  const deps: SyncDeps = {
    getTransportAddressById: async (transportAddressId, tx) => {
      assert.equal(tx, queryable)
      calls.push(`address:${transportAddressId}`)
      return testAddress()
    },
    selectConversationTransportBindingForAddressSync: async (
      conversationId,
      tx
    ) => {
      assert.equal(tx, queryable)
      calls.push(`binding:${conversationId}`)
      return {
        workspaceId: "ws-1",
        transportAccountId: "acct-1",
      }
    },
    activateConversationParticipant: async (params) => {
      assert.equal(params.queryable, queryable)
      assert.equal(params.participantType, "external")
      assert.equal(params.transportAddressId, "addr-1")
      calls.push(`activate:${params.participantType}`)
      return {
        member: { id: "participant-1" },
        activated: true,
        created: true,
        revived: false,
      } as Awaited<ReturnType<SyncDeps["activateConversationParticipant"]>>
    },
    ensureConversationParticipantTransportAddress: async (params) => {
      assert.equal(params.queryable, queryable)
      assert.equal(params.conversationParticipantId, "participant-1")
      assert.equal(params.transportAddressId, "addr-1")
      assert.equal(params.isPrimary, true)
      calls.push("attach")
    },
    selectAttachedParticipantsForAddress: async (params) => {
      assert.equal(params.queryable, queryable)
      assert.equal(params.excludeParticipantId, "participant-1")
      calls.push("attached")
      return [{ id: "stale-participant" }]
    },
    detachParticipantAddress: async (params) => {
      assert.equal(params.queryable, queryable)
      assert.equal(params.conversationParticipantId, "stale-participant")
      calls.push("detach")
    },
    archiveConversationParticipantIfOrphaned: async (
      conversationParticipantId,
      tx
    ) => {
      assert.equal(tx, queryable)
      assert.equal(conversationParticipantId, "stale-participant")
      calls.push("archive")
    },
  }

  const result = await syncTransportAddressConversationParticipantUseCase(
    {
      conversationId: "conversation-1",
      transportAddressId: "addr-1",
      recordJoinEvent: true,
    },
    queryable,
    deps
  )

  assert.equal(result.id, "participant-1")
  assert.deepEqual(calls, [
    "address:addr-1",
    "binding:conversation-1",
    "activate:external",
    "attach",
    "attached",
    "detach",
    "archive",
  ])
})

test("syncTransportAddressConversationParticipantUseCase stops stale detach/archive when address attach fails", async () => {
  const queryable = { tx: "same" } as unknown as Executor
  const calls: string[] = []
  const deps: SyncDeps = {
    getTransportAddressById: async (_transportAddressId, tx) => {
      assert.equal(tx, queryable)
      calls.push("address")
      return testAddress()
    },
    selectConversationTransportBindingForAddressSync: async (
      _conversationId,
      tx
    ) => {
      assert.equal(tx, queryable)
      calls.push("binding")
      return {
        workspaceId: "ws-1",
        transportAccountId: "acct-1",
      }
    },
    activateConversationParticipant: async (params) => {
      assert.equal(params.queryable, queryable)
      calls.push("activate")
      return {
        member: { id: "participant-1" },
        activated: true,
        created: true,
        revived: false,
      } as Awaited<ReturnType<SyncDeps["activateConversationParticipant"]>>
    },
    ensureConversationParticipantTransportAddress: async (params) => {
      assert.equal(params.queryable, queryable)
      calls.push("attach")
      throw new Error("simulated attach failure")
    },
    selectAttachedParticipantsForAddress: async () => {
      throw new Error("should not list stale participants after attach failure")
    },
    detachParticipantAddress: async () => {
      throw new Error("should not detach after attach failure")
    },
    archiveConversationParticipantIfOrphaned: async () => {
      throw new Error("should not archive after attach failure")
    },
  }

  await assert.rejects(
    syncTransportAddressConversationParticipantUseCase(
      {
        conversationId: "conversation-1",
        transportAddressId: "addr-1",
      },
      queryable,
      deps
    ),
    /simulated attach failure/
  )
  assert.deepEqual(calls, ["address", "binding", "activate", "attach"])
})

test("setTransportAddressLinkedUserUseCase threads one executor through ownership update and every conversation sync", async () => {
  const queryable = { tx: "same" } as unknown as Executor
  const calls: string[] = []
  const deps: SetLinkedUserDeps = {
    assertWorkspaceMember: async (params, tx) => {
      assert.equal(tx, queryable)
      assert.equal(params.workspaceId, "ws-1")
      assert.equal(params.workspaceMemberId, "member-1")
      calls.push("member")
      return true
    },
    updateTransportAddressLinkedMember: async (params) => {
      assert.equal(params.queryable, queryable)
      assert.equal(params.workspaceId, "ws-1")
      assert.equal(params.transportAddressId, "addr-1")
      assert.equal(params.workspaceMemberId, "member-1")
      calls.push("link")
      return { id: "addr-1" }
    },
    selectConversationIdsForTransportAddress: async (
      transportAddressId,
      tx
    ) => {
      assert.equal(tx, queryable)
      assert.equal(transportAddressId, "addr-1")
      calls.push("conversations")
      return ["conversation-1", "conversation-2"]
    },
    syncTransportAddressConversationParticipant: async (params, tx) => {
      assert.equal(tx, queryable)
      assert.equal(params.transportAddressId, "addr-1")
      assert.equal(params.workspaceMemberId, "member-1")
      assert.equal(params.recordJoinEvent, false)
      calls.push(`sync:${params.conversationId}`)
    },
  }

  const result = await setTransportAddressLinkedUserUseCase(
    {
      workspaceId: "ws-1",
      transportAddressId: "addr-1",
      workspaceMemberId: "member-1",
    },
    queryable,
    deps
  )

  assert.deepEqual(result, { transportAddressId: "addr-1" })
  assert.deepEqual(calls, [
    "member",
    "link",
    "conversations",
    "sync:conversation-1",
    "sync:conversation-2",
  ])
})

test("setTransportAddressLinkedUserUseCase stops remaining conversation syncs on failure", async () => {
  const queryable = { tx: "same" } as unknown as Executor
  const calls: string[] = []
  const deps: SetLinkedUserDeps = {
    assertWorkspaceMember: async () => {
      calls.push("member")
      return true
    },
    updateTransportAddressLinkedMember: async (params) => {
      assert.equal(params.queryable, queryable)
      calls.push("link")
      return { id: "addr-1" }
    },
    selectConversationIdsForTransportAddress: async (
      _transportAddressId,
      tx
    ) => {
      assert.equal(tx, queryable)
      calls.push("conversations")
      return ["conversation-1", "conversation-2", "conversation-3"]
    },
    syncTransportAddressConversationParticipant: async (params, tx) => {
      assert.equal(tx, queryable)
      calls.push(`sync:${params.conversationId}`)
      if (params.conversationId === "conversation-2") {
        throw new Error("simulated conversation sync failure")
      }
    },
  }

  await assert.rejects(
    setTransportAddressLinkedUserUseCase(
      {
        workspaceId: "ws-1",
        transportAddressId: "addr-1",
        workspaceMemberId: "member-1",
      },
      queryable,
      deps
    ),
    /simulated conversation sync failure/
  )
  assert.deepEqual(calls, [
    "member",
    "link",
    "conversations",
    "sync:conversation-1",
    "sync:conversation-2",
  ])
})
