import test from "node:test"
import assert from "node:assert/strict"
import {
  parseWeixinQrCodeResponseText,
  parseWeixinQrStatusResponseText,
} from "./qr-login-codec.js"

test("parseWeixinQrCodeResponseText: validates QR-code provider response", () => {
  assert.deepEqual(
    parseWeixinQrCodeResponseText(
      JSON.stringify({
        qrcode: "QR-TOKEN",
        qrcode_img_content: "https://example.com/qr.png",
        extra: true,
      })
    ),
    {
      qrcode: "QR-TOKEN",
      qrcode_img_content: "https://example.com/qr.png",
      extra: true,
    }
  )
  assert.deepEqual(parseWeixinQrCodeResponseText(""), {})
})

test("parseWeixinQrCodeResponseText: rejects malformed or drifted QR-code response", () => {
  assert.equal(parseWeixinQrCodeResponseText("{not-json"), null)
  assert.equal(
    parseWeixinQrCodeResponseText(JSON.stringify({ qrcode: 123 })),
    null
  )
  assert.equal(parseWeixinQrCodeResponseText(JSON.stringify([])), null)
})

test("parseWeixinQrStatusResponseText: validates status provider response", () => {
  assert.deepEqual(
    parseWeixinQrStatusResponseText(
      JSON.stringify({
        status: "confirmed",
        bot_token: "TOKEN",
        ilink_bot_id: "BOT",
        baseurl: "https://example.com",
        ilink_user_id: "USER",
      })
    ),
    {
      status: "confirmed",
      bot_token: "TOKEN",
      ilink_bot_id: "BOT",
      baseurl: "https://example.com",
      ilink_user_id: "USER",
    }
  )
  assert.deepEqual(parseWeixinQrStatusResponseText(""), {})
})

test("parseWeixinQrStatusResponseText: rejects malformed or drifted status response", () => {
  assert.equal(parseWeixinQrStatusResponseText("{not-json"), null)
  assert.equal(
    parseWeixinQrStatusResponseText(JSON.stringify({ status: "done" })),
    null
  )
  assert.equal(
    parseWeixinQrStatusResponseText(JSON.stringify({ bot_token: 123 })),
    null
  )
  assert.equal(parseWeixinQrStatusResponseText(JSON.stringify(null)), null)
})
