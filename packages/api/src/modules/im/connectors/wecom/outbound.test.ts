import test from "node:test"
import assert from "node:assert/strict"
import type { WsFrame } from "@wecom/aibot-node-sdk"
import { assertIsoInstant } from "@synapse/shared/datetime"
import { sendWecomMessage } from "./outbound.js"
import { _internals, registerHolder } from "./outbound-router.js"
import { buildCanonicalMessage } from "../../messaging/canonical-message.js"
import type { TransportAccountSummary } from "@synapse/shared/types"

type Captured = { chatid?: string; markdownContent?: string }

function installFakeHolder(
  accountId: string,
  reply: WsFrame,
  captured: Captured
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerHolder(accountId, {
    sendMessage: async (chatid: string, body: any) => {
      captured.chatid = chatid
      captured.markdownContent = body?.markdown?.content
      return reply
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
}

function buildAccount(): TransportAccountSummary {
  return {
    id: "acct-1",
    workspaceId: "ws-1",
    transportKind: "wecom",
    accountKey: "bot-1",
    displayName: "WeCom Bot",
    ownerScope: "workspace",
    inboundActorMode: "none",
    connectionMode: "long_connection",
    status: "active",
    credentials: { botId: "bot-1", secret: "s" },
    config: {},
    metadata: {},
    createdAt: assertIsoInstant("2026-01-01T00:00:00.000Z"),
    updatedAt: assertIsoInstant("2026-01-01T00:00:00.000Z"),
  }
}

/**
 * Delivery-link fields the worker injects into every OutboundSendInput.
 * These tests don't exercise per-link metadata, so supply inert values:
 * a stable link id, an empty metadata snapshot, first-attempt counter,
 * and a no-op patch helper.
 */
function deliveryFields() {
  return {
    transportMessageLinkId: "link-1",
    linkMetadata: {} as Record<string, unknown>,
    attemptNumber: 0,
    patchLinkMetadata: async () => {},
  }
}

test.beforeEach(() => {
  _internals.resetForTests()
})

test("externalMessageId fallback chain prefers headers.req_id (primary path)", async () => {
  const captured: Captured = {}
  installFakeHolder(
    "acct-1",
    {
      headers: { req_id: "req-primary" },
      body: { msgid: "msg-secondary" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    captured
  )
  const result = await sendWecomMessage({
    account: buildAccount(),
    endpoint: { endpointType: "direct", externalId: "u-1", metadata: {} },
    message: buildCanonicalMessage([{ type: "text", text: "hi" }]),
    ...deliveryFields(),
  })
  assert.equal(result.externalMessageId, "req-primary")
  assert.equal(captured.chatid, "u-1")
  assert.equal(captured.markdownContent, "hi")
})

test("externalMessageId falls back to body.msgid when req_id missing", async () => {
  const captured: Captured = {}
  installFakeHolder(
    "acct-1",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { headers: {}, body: { msgid: "msg-from-body" } } as any,
    captured
  )
  const result = await sendWecomMessage({
    account: buildAccount(),
    endpoint: { endpointType: "direct", externalId: "u-1", metadata: {} },
    message: buildCanonicalMessage([{ type: "text", text: "y" }]),
    ...deliveryFields(),
  })
  assert.equal(result.externalMessageId, "msg-from-body")
})

test("externalMessageId falls back to fresh uuid when neither present", async () => {
  const captured: Captured = {}
  installFakeHolder(
    "acct-1",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { headers: {}, body: {} } as any,
    captured
  )
  const result = await sendWecomMessage({
    account: buildAccount(),
    endpoint: { endpointType: "direct", externalId: "u-1", metadata: {} },
    message: buildCanonicalMessage([{ type: "text", text: "z" }]),
    ...deliveryFields(),
  })
  // UUID v4 form 8-4-4-4-12
  assert.ok(result.externalMessageId)
  assert.match(
    result.externalMessageId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  )
})

test("degradation strips image/file parts before render", async () => {
  const captured: Captured = {}
  installFakeHolder(
    "acct-1",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { headers: { req_id: "r" }, body: {} } as any,
    captured
  )
  await sendWecomMessage({
    account: buildAccount(),
    endpoint: { endpointType: "group", externalId: "g-9", metadata: {} },
    message: buildCanonicalMessage([
      { type: "text", text: "before " },
      { type: "image", fileRef: { sha256: "x" } },
      { type: "text", text: " after" },
    ]),
    ...deliveryFields(),
  })
  // Capabilities have supportsImage:false → degraded to a system marker
  // text "[图片]" by `degradeForCapabilities`, then renderer concatenates.
  assert.match(captured.markdownContent ?? "", /before/)
  assert.match(captured.markdownContent ?? "", /after/)
  assert.match(captured.markdownContent ?? "", /图片/)
})

test("chatid is endpoint.externalId regardless of direct/group", async () => {
  const captured: Captured = {}
  installFakeHolder(
    "acct-1",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { headers: { req_id: "r" }, body: {} } as any,
    captured
  )
  await sendWecomMessage({
    account: buildAccount(),
    endpoint: { endpointType: "group", externalId: "g-xyz", metadata: {} },
    message: buildCanonicalMessage([{ type: "text", text: "x" }]),
    ...deliveryFields(),
  })
  assert.equal(captured.chatid, "g-xyz")
})
