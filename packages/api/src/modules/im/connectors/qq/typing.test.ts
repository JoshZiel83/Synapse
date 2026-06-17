import test from "node:test"
import assert from "node:assert/strict"
import { createQqTypingAdapter } from "./typing.js"
import type { TransportAccountSummary } from "@synapse/shared/types"

const account = {
  id: "acc-1",
  workspaceId: "ws",
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

test("createQqTypingAdapter: group endpoint → null", () => {
  const result = createQqTypingAdapter({
    account,
    endpointRef: {
      endpointType: "group",
      externalId: "GRP1",
      metadata: {},
    },
    lastInboundMessageRef: {
      externalMessageId: "M",
      endpointExternalId: "GRP1",
    },
  })
  assert.equal(result, null)
})

test("createQqTypingAdapter: direct endpoint without msg_id → null", () => {
  const result = createQqTypingAdapter({
    account,
    endpointRef: {
      endpointType: "direct",
      externalId: "c2c:USER1",
      metadata: {},
    },
  })
  assert.equal(result, null)
})

test("createQqTypingAdapter: direct endpoint with bad external_id → null", () => {
  const result = createQqTypingAdapter({
    account,
    endpointRef: {
      endpointType: "direct",
      externalId: "gm:GRP:MEM", // not a c2c external id
      metadata: {},
    },
    lastInboundMessageRef: {
      externalMessageId: "M",
      endpointExternalId: "gm:GRP:MEM",
    },
  })
  assert.equal(result, null)
})

test("createQqTypingAdapter: direct + msg_id → null (QQ v2 has no typing API)", () => {
  const result = createQqTypingAdapter({
    account,
    endpointRef: {
      endpointType: "direct",
      externalId: "c2c:USER1",
      metadata: {},
    },
    lastInboundMessageRef: {
      externalMessageId: "MSG1",
      endpointExternalId: "c2c:USER1",
    },
  })
  assert.equal(result, null)
})
