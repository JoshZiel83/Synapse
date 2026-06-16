import test from "node:test"
import assert from "node:assert/strict"
import { WEIXIN_QR_LOGIN_STATUS } from "@synapse/shared"
import {
  parseWeixinQrSessionPayload,
  type ActiveWeixinQrLogin,
} from "./qr-session-store.js"

function fresh(patch: Partial<ActiveWeixinQrLogin> = {}): ActiveWeixinQrLogin {
  return {
    sessionId: "sess",
    workspaceId: "ws",
    qrcode: "qr-token",
    qrCodeUrl: "https://example.com/qr.png",
    baseUrl: "https://ilinkai.weixin.qq.com",
    botType: "bot",
    displayName: "Weixin Bot",
    ownerScope: "workspace",
    ownerWorkspaceMemberId: null,
    inboundActorMode: "none",
    inboundActorId: null,
    status: WEIXIN_QR_LOGIN_STATUS.WAITING,
    message: "Scan the QR code",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    expiresAt: Date.now() + 300_000,
    ...patch,
  }
}

test("parseWeixinQrSessionPayload: accepts valid Redis payload", () => {
  const session = fresh({
    transportAccountId: "acct",
    botId: "bot-id",
    scannerUserId: "scanner",
  })
  assert.deepEqual(
    parseWeixinQrSessionPayload(JSON.stringify(session)),
    session
  )
})

test("parseWeixinQrSessionPayload: rejects malformed or drifted Redis payload", () => {
  assert.equal(parseWeixinQrSessionPayload("{not-json"), null)
  assert.equal(
    parseWeixinQrSessionPayload(JSON.stringify({ ...fresh(), status: "done" })),
    null
  )
  assert.equal(
    parseWeixinQrSessionPayload(
      JSON.stringify({ ...fresh(), ownerScope: "owner" })
    ),
    null
  )
  assert.equal(
    parseWeixinQrSessionPayload(
      JSON.stringify({ ...fresh(), expiresAt: "soon" })
    ),
    null
  )
})
