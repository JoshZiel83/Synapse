import test from "node:test"
import assert from "node:assert/strict"
import type {
  ConversationTransportBindingSummary,
  TransportAccountSummary,
  TransportMessageLink,
} from "@synapse/shared/types"
import type { DatabaseTransaction } from "../../../infrastructure/database/kysely.js"
import { buildCanonicalMessage } from "../messaging/canonical-message.js"
import {
  ingestInboundEnvelopeUseCase,
  type IngestInboundEnvelopeDeps,
} from "./inbound-message.js"

function accountFixture(
  metadata: Record<string, unknown> = {}
): TransportAccountSummary {
  return {
    id: "account-1",
    workspaceId: "workspace-1",
    transportKind: "wecom",
    accountKey: "wecom:account-1",
    displayName: "WeCom",
    ownerScope: "workspace_member",
    ownerWorkspaceMemberId: "owner-member-1",
    inboundActorMode: "specified_actor",
    inboundActorId: "actor-1",
    connectionMode: "webhook",
    status: "active",
    config: {},
    metadata,
    createdAt: "2026-06-16T00:00:00.000Z",
    updatedAt: "2026-06-16T00:00:00.000Z",
  } as TransportAccountSummary
}

function bindingFixture(): ConversationTransportBindingSummary {
  const account = accountFixture()
  return {
    id: "binding-1",
    conversationId: "conversation-1",
    workspaceId: "workspace-1",
    transportKind: "wecom",
    outboundEnabled: true,
    inboundActorMode: "inherit_account",
    metadata: {},
    createdAt: "2026-06-16T00:00:00.000Z",
    updatedAt: "2026-06-16T00:00:00.000Z",
    account,
    endpoint: {
      id: "endpoint-1",
      transportAccountId: account.id,
      transportKind: "wecom",
      endpointType: "group",
      externalId: "room-1",
      displayName: "Room",
      metadata: {},
      createdAt: "2026-06-16T00:00:00.000Z",
      updatedAt: "2026-06-16T00:00:00.000Z",
    },
  } as ConversationTransportBindingSummary
}

function inboundEnvelopeFixture() {
  return {
    endpointType: "group" as const,
    endpointExternalId: "room-1",
    endpointDisplayName: "Room",
    externalMessageId: "external-message-1",
    externalReplyToId: "reply-1",
    externalThreadId: "thread-1",
    sender: {
      externalId: "user-external-1",
      displayName: "External User",
      metadata: { department: "R&D" },
    },
    receivedAt: "2026-06-16T00:00:01.000Z",
    message: buildCanonicalMessage([{ type: "text", text: "hello" }]),
    endpointMetadata: { topic: "support" },
    raw: {
      externalMessageId: "spoofed",
      transport: {
        externalReplyToId: "spoofed-reply",
      },
    },
  }
}

function linkFixture(id = "link-1"): TransportMessageLink {
  return {
    id,
    conversationId: "conversation-1",
    itemId: "item-1",
    transportKind: "wecom",
    transportEndpointId: "endpoint-1",
    direction: "inbound",
    deliveryStatus: "sent",
    externalMessageId: "external-message-1",
    metadata: {},
    createdAt: "2026-06-16T00:00:02.000Z",
    updatedAt: "2026-06-16T00:00:02.000Z",
  } as TransportMessageLink
}

function depsFixture(
  overrides: Partial<IngestInboundEnvelopeDeps> = {}
): IngestInboundEnvelopeDeps {
  const binding = bindingFixture()
  return {
    runInTransaction: async (callback) => callback({} as DatabaseTransaction),
    ensureTransportConversationBinding: async () => binding,
    findTransportMessageLinkByExternalMessage: async () => null,
    ensureTransportAddress: async () => ({
      id: "address-1",
      workspaceMemberId: null,
    }),
    getPendingTransportAccountAutoLinkWorkspaceMemberId: () => undefined,
    consumeTransportAccountAutoLink: async () => {},
    syncTransportAddressConversationParticipant: async () => ({
      id: "participant-1",
    }),
    updateTransportAddressMetadata: async () => {},
    updateTransportEndpointMetadata: async () => {},
    attachDefaultWakeTarget: async () => {},
    createConversationItem: async () => ({ id: "item-1" }),
    queueConversationTransportProjection: async () => linkFixture(),
    updateTransportMessageLinkStatus: async () => {},
    enqueueActorWakeupsForConversationMessage: async () => {},
    notifyRemoteAgentDeliveriesForConversation: async () => {},
    ...overrides,
  }
}

test("ingestInboundEnvelopeUseCase returns existing inbound link before side effects", async () => {
  const existing = linkFixture("existing-link")
  const calls: string[] = []

  const result = await ingestInboundEnvelopeUseCase(
    {
      account: accountFixture(),
      envelope: inboundEnvelopeFixture(),
    },
    depsFixture({
      findTransportMessageLinkByExternalMessage: async (params) => {
        calls.push(`dedupe:${params.externalMessageId}`)
        return existing
      },
      ensureTransportAddress: async () => {
        calls.push("ensure-address")
        throw new Error("should not run")
      },
    })
  )

  assert.equal(result, existing)
  assert.deepEqual(calls, ["dedupe:external-message-1"])
})

test("ingestInboundEnvelopeUseCase writes inbound item, link projection, and post-write notifications", async () => {
  const account = accountFixture({
    pendingAutoLinkWorkspaceMemberId: "workspace-member-1",
    pendingAutoLinkMode: "next_message",
    pendingAutoLinkConfiguredAt: "2026-06-16T00:00:00.000Z",
  })
  const envelope = inboundEnvelopeFixture()
  const callOrder: string[] = []
  const createItemCalls: unknown[] = []
  const projectionCalls: unknown[] = []

  const result = await ingestInboundEnvelopeUseCase(
    { account, envelope },
    depsFixture({
      getPendingTransportAccountAutoLinkWorkspaceMemberId: () =>
        "workspace-member-1",
      consumeTransportAccountAutoLink: async (params) => {
        callOrder.push("consume-auto-link")
        assert.equal(params.transportAddressId, "address-1")
        assert.equal(params.targetWorkspaceMemberId, "workspace-member-1")
        assert.equal(params.matchedExternalId, "user-external-1")
      },
      syncTransportAddressConversationParticipant: async (params) => {
        callOrder.push("sync-participant")
        assert.equal(params.workspaceMemberId, "workspace-member-1")
        assert.equal(params.displayName, "External User")
        return { id: "participant-1" }
      },
      updateTransportAddressMetadata: async (params) => {
        callOrder.push("update-address-metadata")
        assert.deepEqual(params.metadata, { department: "R&D" })
      },
      updateTransportEndpointMetadata: async (params) => {
        callOrder.push("update-endpoint-metadata")
        assert.deepEqual(params.metadata, { topic: "support" })
      },
      attachDefaultWakeTarget: async () => {
        callOrder.push("attach-wake-target")
      },
      createConversationItem: async (params) => {
        callOrder.push("create-item")
        createItemCalls.push(params)
        assert.equal(params.workspaceId, "workspace-1")
        assert.equal(params.conversationId, "conversation-1")
        assert.equal(params.authorParticipantId, "participant-1")
        assert.deepEqual(params.parts, [{ type: "text", text: "hello" }])
        assert.equal(
          (params.metadata.transport as Record<string, unknown>)
            .externalMessageId,
          "external-message-1"
        )
        assert.equal(
          (params.metadata.transport as Record<string, unknown>)
            .externalReplyToId,
          "reply-1"
        )
        return { id: "item-1" }
      },
      queueConversationTransportProjection: async (params) => {
        callOrder.push("queue-projection")
        projectionCalls.push(params)
        assert.equal(params.itemId, "item-1")
        assert.equal(params.externalMessageId, "external-message-1")
        assert.equal(params.externalReplyToId, "reply-1")
        assert.equal(params.externalThreadId, "thread-1")
        return linkFixture()
      },
      updateTransportMessageLinkStatus: async (params) => {
        callOrder.push("mark-link-sent")
        assert.equal(params.linkId, "link-1")
        assert.equal(params.status, "sent")
      },
      enqueueActorWakeupsForConversationMessage: async (params) => {
        callOrder.push("enqueue-wakeups")
        assert.equal(params.itemId, "item-1")
      },
      notifyRemoteAgentDeliveriesForConversation: async (conversationId) => {
        callOrder.push("notify-remote-agents")
        assert.equal(conversationId, "conversation-1")
      },
    })
  )

  assert.equal(result?.id, "link-1")
  assert.deepEqual(callOrder, [
    "consume-auto-link",
    "sync-participant",
    "update-address-metadata",
    "update-endpoint-metadata",
    "attach-wake-target",
    "create-item",
    "queue-projection",
    "mark-link-sent",
    "enqueue-wakeups",
    "notify-remote-agents",
  ])
  assert.equal(createItemCalls.length, 1)
  assert.equal(projectionCalls.length, 1)
  assert.equal(account.metadata.pendingAutoLinkWorkspaceMemberId, undefined)
  assert.equal(account.metadata.pendingAutoLinkMode, undefined)
  assert.equal(account.metadata.pendingAutoLinkConfiguredAt, undefined)
})

test("ingestInboundEnvelopeUseCase threads one transaction through item projection and status updates", async () => {
  const tx = {} as DatabaseTransaction
  const callOrder: string[] = []

  const result = await ingestInboundEnvelopeUseCase(
    {
      account: accountFixture(),
      envelope: inboundEnvelopeFixture(),
    },
    depsFixture({
      runInTransaction: async (callback) => {
        callOrder.push("begin")
        const value = await callback(tx)
        callOrder.push("commit")
        return value
      },
      createConversationItem: async (params) => {
        callOrder.push("create-item")
        assert.equal(params.queryable, tx)
        return { id: "item-1" }
      },
      queueConversationTransportProjection: async (params) => {
        callOrder.push("queue-projection")
        assert.equal(params.tx, tx)
        assert.equal(params.itemId, "item-1")
        return linkFixture()
      },
      updateTransportMessageLinkStatus: async (params) => {
        callOrder.push("mark-link-sent")
        assert.equal(params.tx, tx)
        assert.equal(params.linkId, "link-1")
      },
      enqueueActorWakeupsForConversationMessage: async () => {
        callOrder.push("enqueue-wakeups")
      },
      notifyRemoteAgentDeliveriesForConversation: async () => {
        callOrder.push("notify-remote-agents")
      },
    })
  )

  assert.equal(result?.id, "link-1")
  assert.deepEqual(callOrder, [
    "begin",
    "create-item",
    "queue-projection",
    "mark-link-sent",
    "commit",
    "enqueue-wakeups",
    "notify-remote-agents",
  ])
})

test("ingestInboundEnvelopeUseCase returns raced inbound link after unique conflict and skips notifications", async () => {
  const existing = linkFixture("existing-link")
  const uniqueError = Object.assign(new Error("duplicate inbound message"), {
    code: "23505",
    constraint: "uq_transport_message_links_inbound_external_message",
  })
  const callOrder: string[] = []
  let dedupeReads = 0

  const result = await ingestInboundEnvelopeUseCase(
    {
      account: accountFixture(),
      envelope: inboundEnvelopeFixture(),
    },
    depsFixture({
      findTransportMessageLinkByExternalMessage: async (params) => {
        dedupeReads += 1
        callOrder.push(
          dedupeReads === 1 ? "dedupe-before" : "dedupe-after-conflict"
        )
        assert.equal(params.transportAccountId, "account-1")
        assert.equal(params.transportEndpointId, "endpoint-1")
        assert.equal(params.externalMessageId, "external-message-1")
        assert.equal(params.direction, "inbound")
        return dedupeReads === 1 ? null : existing
      },
      runInTransaction: async (callback) => {
        callOrder.push("begin")
        return callback({} as DatabaseTransaction)
      },
      createConversationItem: async () => {
        callOrder.push("create-item")
        return { id: "raced-item" }
      },
      queueConversationTransportProjection: async () => {
        callOrder.push("queue-projection")
        throw uniqueError
      },
      updateTransportMessageLinkStatus: async () => {
        callOrder.push("mark-link-sent")
        throw new Error("should not run")
      },
      enqueueActorWakeupsForConversationMessage: async () => {
        callOrder.push("enqueue-wakeups")
        throw new Error("should not run")
      },
      notifyRemoteAgentDeliveriesForConversation: async () => {
        callOrder.push("notify-remote-agents")
        throw new Error("should not run")
      },
    })
  )

  assert.equal(result, existing)
  assert.deepEqual(callOrder, [
    "dedupe-before",
    "begin",
    "create-item",
    "queue-projection",
    "dedupe-after-conflict",
  ])
})

test("ingestInboundEnvelopeUseCase rethrows unrelated unique conflicts", async () => {
  const uniqueError = Object.assign(new Error("other unique conflict"), {
    code: "23505",
    constraint: "some_other_unique_index",
  })
  const callOrder: string[] = []

  await assert.rejects(
    () =>
      ingestInboundEnvelopeUseCase(
        {
          account: accountFixture(),
          envelope: inboundEnvelopeFixture(),
        },
        depsFixture({
          findTransportMessageLinkByExternalMessage: async () => {
            callOrder.push("dedupe-before")
            return null
          },
          runInTransaction: async (callback) => {
            callOrder.push("begin")
            return callback({} as DatabaseTransaction)
          },
          createConversationItem: async () => {
            callOrder.push("create-item")
            return { id: "raced-item" }
          },
          queueConversationTransportProjection: async () => {
            callOrder.push("queue-projection")
            throw uniqueError
          },
          enqueueActorWakeupsForConversationMessage: async () => {
            callOrder.push("enqueue-wakeups")
            throw new Error("should not run")
          },
        })
      ),
    /other unique conflict/
  )

  assert.deepEqual(callOrder, [
    "dedupe-before",
    "begin",
    "create-item",
    "queue-projection",
  ])
})

test("ingestInboundEnvelopeUseCase stops projection and notifications when item creation fails", async () => {
  const callOrder: string[] = []

  await assert.rejects(
    () =>
      ingestInboundEnvelopeUseCase(
        {
          account: accountFixture(),
          envelope: inboundEnvelopeFixture(),
        },
        depsFixture({
          createConversationItem: async () => {
            callOrder.push("create-item")
            throw new Error("item insert failed")
          },
          queueConversationTransportProjection: async () => {
            callOrder.push("queue-projection")
            throw new Error("should not run")
          },
          updateTransportMessageLinkStatus: async () => {
            callOrder.push("mark-link-sent")
            throw new Error("should not run")
          },
          enqueueActorWakeupsForConversationMessage: async () => {
            callOrder.push("enqueue-wakeups")
            throw new Error("should not run")
          },
          notifyRemoteAgentDeliveriesForConversation: async () => {
            callOrder.push("notify-remote-agents")
            throw new Error("should not run")
          },
        })
      ),
    /item insert failed/
  )

  assert.deepEqual(callOrder, ["create-item"])
})

test("ingestInboundEnvelopeUseCase stops post-projection side effects when transport projection fails", async () => {
  const callOrder: string[] = []

  await assert.rejects(
    () =>
      ingestInboundEnvelopeUseCase(
        {
          account: accountFixture(),
          envelope: inboundEnvelopeFixture(),
        },
        depsFixture({
          createConversationItem: async () => {
            callOrder.push("create-item")
            return { id: "item-1" }
          },
          queueConversationTransportProjection: async () => {
            callOrder.push("queue-projection")
            throw new Error("projection failed")
          },
          updateTransportMessageLinkStatus: async () => {
            callOrder.push("mark-link-sent")
            throw new Error("should not run")
          },
          enqueueActorWakeupsForConversationMessage: async () => {
            callOrder.push("enqueue-wakeups")
            throw new Error("should not run")
          },
          notifyRemoteAgentDeliveriesForConversation: async () => {
            callOrder.push("notify-remote-agents")
            throw new Error("should not run")
          },
        })
      ),
    /projection failed/
  )

  assert.deepEqual(callOrder, ["create-item", "queue-projection"])
})
