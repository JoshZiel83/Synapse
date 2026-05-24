import test from "node:test"
import assert from "node:assert/strict"
import {
  mergeInboundMetadata,
  type BuiltInTransport,
} from "./ingest-metadata.js"

const BUILT: BuiltInTransport = {
  direction: "inbound",
  transportKind: "feishu",
  transportAccountId: "acct-1",
  endpointType: "direct",
  endpointExternalId: "oc_p",
  externalMessageId: "om_1",
  transportAddressId: "addr-1",
  senderExternalId: "ou_a",
}

test("empty incoming metadata yields just built transport", () => {
  const out = mergeInboundMetadata(BUILT, undefined)
  assert.deepEqual(out, { transport: BUILT })
})

test("incoming transport keys extend, runtime-built keys WIN", () => {
  const out = mergeInboundMetadata(BUILT, {
    transport: {
      canonicalParts: [{ type: "text", text: "x" }],
      externalReplyToId: "om_parent",
      externalThreadId: "omt_t",
      // attempt to override a runtime-required key
      externalMessageId: "om_attacker",
      transportKind: "weixin",
    },
  })
  assert.equal(
    (out.transport as Record<string, unknown>).externalMessageId,
    "om_1",
    "runtime externalMessageId must not be overwritten"
  )
  assert.equal(
    (out.transport as Record<string, unknown>).transportKind,
    "feishu",
    "runtime transportKind must not be overwritten"
  )
  assert.deepEqual((out.transport as Record<string, unknown>).canonicalParts, [
    { type: "text", text: "x" },
  ])
  assert.equal(
    (out.transport as Record<string, unknown>).externalReplyToId,
    "om_parent"
  )
})

test("non-transport keys flow through unchanged", () => {
  const out = mergeInboundMetadata(BUILT, {
    transport: { canonicalParts: [] },
    customField: { foo: 1 },
  })
  assert.deepEqual(out.customField, { foo: 1 })
})

test("malformed incoming.transport is treated as empty", () => {
  const out = mergeInboundMetadata(BUILT, {
    transport: "not-an-object" as unknown as Record<string, unknown>,
  })
  assert.deepEqual(out.transport, BUILT)
})

test("regression: pre-fix bug used to overwrite transport entirely", () => {
  // This is exactly what the old code looked like; assert the new
  // behavior is the opposite.
  const out = mergeInboundMetadata(BUILT, {
    transport: { transportKind: "weixin" }, // attacker payload from connector
  })
  // Old bug: out.transport.transportKind === "weixin"
  // Fix:    runtime keeps its own transportKind
  assert.equal(
    (out.transport as Record<string, unknown>).transportKind,
    "feishu"
  )
})
