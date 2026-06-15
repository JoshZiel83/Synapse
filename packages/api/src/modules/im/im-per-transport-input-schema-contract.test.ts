import test from "node:test"
import assert from "node:assert/strict"
import {
  DingtalkDeviceFlowStartInputSchema,
  DingtalkManualAccountCreateInputSchema,
  TransportFeishuAccountCreateInputSchema,
  TransportFeishuAccountUpdateInputSchema,
  TransportQqAccountCreateInputSchema,
  TransportQqAccountUpdateInputSchema,
  TransportWecomAccountCreateInputSchema,
  TransportWecomAccountUpdateInputSchema,
  WeixinBindingAutoLinkInputSchema,
  WeixinQrSessionCreateInputSchema,
} from "@synapse/shared/schemas"
import {
  bindingAutoLinkSchema,
  feishuAccountSchema,
  qqAccountSchema,
  updateFeishuAccountSchema,
  updateQqAccountSchema,
  updateWecomAccountSchema,
  wecomAccountSchema,
  weixinQrSessionSchema,
} from "./controller/_shared.js"

test("IM controller per-transport aliases point at shared app input schemas", () => {
  assert.equal(feishuAccountSchema, TransportFeishuAccountCreateInputSchema)
  assert.equal(
    updateFeishuAccountSchema,
    TransportFeishuAccountUpdateInputSchema
  )
  assert.equal(wecomAccountSchema, TransportWecomAccountCreateInputSchema)
  assert.equal(updateWecomAccountSchema, TransportWecomAccountUpdateInputSchema)
  assert.equal(qqAccountSchema, TransportQqAccountCreateInputSchema)
  assert.equal(updateQqAccountSchema, TransportQqAccountUpdateInputSchema)
  assert.equal(weixinQrSessionSchema, WeixinQrSessionCreateInputSchema)
  assert.equal(bindingAutoLinkSchema, WeixinBindingAutoLinkInputSchema)
})

test("TransportFeishuAccountCreateInputSchema validates owner and inbound actor invariants", () => {
  const accepted = TransportFeishuAccountCreateInputSchema.safeParse({
    displayName: "Feishu Bot",
    connectionMode: "webhook",
    appId: "cli_xxx",
    appSecret: "secret",
    ownerScope: "workspace_member",
    ownerWorkspaceMemberId: crypto.randomUUID(),
    inboundActorMode: "follow_owner_chief_actor",
  })
  assert.equal(accepted.success, true)

  const rejected = TransportFeishuAccountCreateInputSchema.safeParse({
    displayName: "Feishu Bot",
    connectionMode: "webhook",
    appId: "cli_xxx",
    appSecret: "secret",
    ownerScope: "workspace",
    inboundActorMode: "follow_owner_chief_actor",
  })
  assert.equal(rejected.success, false)
})

test("TransportWecomAccountCreateInputSchema preserves strict baseWsUrl contract", () => {
  const accepted = TransportWecomAccountCreateInputSchema.parse({
    displayName: "WeCom Bot",
    botId: "bot-1",
    secret: "secret-1",
    baseWsUrl: "wss://openws.work.weixin.qq.com",
  })
  assert.equal(accepted.connectionMode, "long_connection")

  const snakeCase = TransportWecomAccountCreateInputSchema.safeParse({
    displayName: "WeCom Bot",
    botId: "bot-1",
    secret: "secret-1",
    base_ws_url: "wss://openws.work.weixin.qq.com",
  })
  assert.equal(snakeCase.success, false)

  const badScheme = TransportWecomAccountUpdateInputSchema.safeParse({
    baseWsUrl: "https://example.com",
  })
  assert.equal(badScheme.success, false)
})

test("TransportQqAccountUpdateInputSchema validates shared owner and config shape", () => {
  const accepted = TransportQqAccountUpdateInputSchema.safeParse({
    webhookInboundConfirmed: true,
    allowProactiveBestEffort: false,
    configuredUrlDomains: ["qq.example.com"],
  })
  assert.equal(accepted.success, true)

  const rejected = TransportQqAccountUpdateInputSchema.safeParse({
    inboundActorMode: "specified_actor",
  })
  assert.equal(rejected.success, false)
})

test("Weixin QR and binding app inputs reject invalid app shapes", () => {
  const qrAccepted = WeixinQrSessionCreateInputSchema.safeParse({
    displayName: "Weixin Bot",
    baseUrl: "https://ilinkai.weixin.qq.com",
  })
  assert.equal(qrAccepted.success, true)

  const qrRejected = WeixinQrSessionCreateInputSchema.safeParse({
    displayName: "Weixin Bot",
    baseUrl: "not-a-url",
  })
  assert.equal(qrRejected.success, false)

  const linkAccepted = WeixinBindingAutoLinkInputSchema.safeParse({
    workspaceMemberId: null,
  })
  assert.equal(linkAccepted.success, true)

  const linkRejected = WeixinBindingAutoLinkInputSchema.safeParse({
    workspace_member_id: crypto.randomUUID(),
  })
  assert.equal(linkRejected.success, false)
})

test("DingTalk device-flow and manual account inputs use shared owner/inbound constraints", () => {
  const deviceFlowAccepted = DingtalkDeviceFlowStartInputSchema.safeParse({
    displayName: "DingTalk Bot",
    ownerScope: "workspace_member",
    ownerWorkspaceMemberId: crypto.randomUUID(),
    inboundActorMode: "follow_owner_chief_actor",
  })
  assert.equal(deviceFlowAccepted.success, true)

  const deviceFlowRejected = DingtalkDeviceFlowStartInputSchema.safeParse({
    displayName: "DingTalk Bot",
    ownerScope: "workspace",
    inboundActorMode: "follow_owner_chief_actor",
  })
  assert.equal(deviceFlowRejected.success, false)

  const manualAccepted = DingtalkManualAccountCreateInputSchema.safeParse({
    clientId: "ding-client-id",
    clientSecret: "ding-client-secret",
    displayName: "DingTalk Bot",
  })
  assert.equal(manualAccepted.success, true)

  const manualRejected = DingtalkManualAccountCreateInputSchema.safeParse({
    clientId: "short",
    clientSecret: "secret",
    displayName: "DingTalk Bot",
  })
  assert.equal(manualRejected.success, false)
})
