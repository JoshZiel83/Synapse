import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import {
  CONVERSATION_MESSAGE_TRANSPORT_DIRECTION,
  TRANSPORT_KINDS,
} from "@synapse/shared"
import type { Executor } from "../../infrastructure/database/kysely.js"
import type { ChatTransportDeliveryRow } from "./repo.js"
import {
  loadConversationTransportDeliveriesUseCase,
  mapConversationTransportContext,
  type LoadConversationTransportDeliveriesDeps,
} from "./conversation-transport.js"

const TRANSPORT_KIND = TRANSPORT_KINDS[0]

function deliveryRow(
  itemId: string,
  values: Partial<ChatTransportDeliveryRow> = {}
): ChatTransportDeliveryRow {
  return {
    itemId,
    linkId: randomUUID(),
    transportKind: TRANSPORT_KIND,
    direction: CONVERSATION_MESSAGE_TRANSPORT_DIRECTION.OUTBOUND,
    deliveryStatus: "sent",
    externalMessageId: null,
    metadata: {},
    deliveredAt: null,
    endpointType: "direct",
    endpointExternalId: null,
    endpointDisplayName: null,
    ...values,
  }
}

test("mapConversationTransportContext accepts valid transport metadata", () => {
  const context = mapConversationTransportContext({
    transport: {
      direction: CONVERSATION_MESSAGE_TRANSPORT_DIRECTION.INBOUND,
      transportKind: TRANSPORT_KIND,
      transportAccountId: "account-1",
      endpointType: "group",
      endpointExternalId: "room-1",
      externalMessageId: "message-1",
      transportAddressId: "address-1",
      senderExternalId: "sender-1",
    },
  })

  assert.deepEqual(context, {
    direction: CONVERSATION_MESSAGE_TRANSPORT_DIRECTION.INBOUND,
    transportKind: TRANSPORT_KIND,
    transportAccountId: "account-1",
    endpointType: "group",
    endpointExternalId: "room-1",
    externalMessageId: "message-1",
    transportAddressId: "address-1",
    senderExternalId: "sender-1",
  })
})

test("mapConversationTransportContext rejects incomplete transport metadata", () => {
  assert.equal(mapConversationTransportContext({}), undefined)
  assert.equal(
    mapConversationTransportContext({
      transport: {
        direction: CONVERSATION_MESSAGE_TRANSPORT_DIRECTION.INBOUND,
      },
    }),
    undefined
  )
})

test("loadConversationTransportDeliveriesUseCase groups deliveries by item", async () => {
  const queryable = {} as Executor
  const firstItemId = randomUUID()
  const secondItemId = randomUUID()
  const deliveredAt = new Date("2026-06-16T00:00:00.000Z")
  const calls: string[][] = []
  const deps: LoadConversationTransportDeliveriesDeps = {
    listTransportDeliveryRowsForItems: async (_queryable, itemIds) => {
      calls.push(itemIds)
      return [
        deliveryRow(firstItemId, {
          endpointExternalId: "first",
          externalMessageId: "external-1",
          deliveredAt,
        }),
        deliveryRow(firstItemId, {
          deliveryStatus: "failed",
          metadata: { reason: "network" },
        }),
        deliveryRow(secondItemId, {
          endpointDisplayName: "Second",
        }),
      ]
    },
  }

  const result = await loadConversationTransportDeliveriesUseCase(
    queryable,
    [firstItemId, secondItemId],
    deps
  )

  assert.deepEqual(calls, [[firstItemId, secondItemId]])
  assert.equal(result.get(firstItemId)?.length, 2)
  assert.equal(result.get(firstItemId)?.[0]?.endpointExternalId, "first")
  assert.equal(result.get(firstItemId)?.[0]?.externalMessageId, "external-1")
  assert.equal(
    result.get(firstItemId)?.[0]?.deliveredAt,
    deliveredAt.toISOString()
  )
  assert.deepEqual(result.get(firstItemId)?.[1]?.metadata, {
    reason: "network",
  })
  assert.equal(result.get(secondItemId)?.[0]?.endpointDisplayName, "Second")
})

test("loadConversationTransportDeliveriesUseCase returns empty without loading rows", async () => {
  let called = false
  const result = await loadConversationTransportDeliveriesUseCase(
    {} as Executor,
    [],
    {
      listTransportDeliveryRowsForItems: async () => {
        called = true
        return []
      },
    }
  )

  assert.equal(called, false)
  assert.equal(result.size, 0)
})
