import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { verifyFeishuWebhookSignature } from "./webhook-signature.js"

function sign(
  timestamp: string,
  nonce: string,
  encryptKey: string,
  payload: unknown
) {
  return crypto
    .createHash("sha256")
    .update(timestamp + nonce + encryptKey + JSON.stringify(payload))
    .digest("hex")
}

test("returns true when encryptKey is empty (signing disabled)", () => {
  assert.equal(
    verifyFeishuWebhookSignature({
      headers: {},
      payload: { x: 1 },
      encryptKey: "",
    }),
    true
  )
})

test("verifies valid signature", () => {
  const ts = "1700000000"
  const nonce = "abc"
  const key = "secret"
  const payload = { hello: "world" }
  const sig = sign(ts, nonce, key, payload)
  assert.equal(
    verifyFeishuWebhookSignature({
      headers: {
        "x-lark-request-timestamp": ts,
        "x-lark-request-nonce": nonce,
        "x-lark-signature": sig,
      },
      payload,
      encryptKey: key,
    }),
    true
  )
})

test("rejects tampered payload", () => {
  const ts = "1700000000"
  const nonce = "abc"
  const key = "secret"
  const sig = sign(ts, nonce, key, { hello: "world" })
  assert.equal(
    verifyFeishuWebhookSignature({
      headers: {
        "x-lark-request-timestamp": ts,
        "x-lark-request-nonce": nonce,
        "x-lark-signature": sig,
      },
      payload: { hello: "evil" },
      encryptKey: key,
    }),
    false
  )
})

test("rejects missing headers", () => {
  assert.equal(
    verifyFeishuWebhookSignature({
      headers: {},
      payload: { x: 1 },
      encryptKey: "secret",
    }),
    false
  )
})

test("rejects when timestamp missing", () => {
  assert.equal(
    verifyFeishuWebhookSignature({
      headers: {
        "x-lark-request-nonce": "n",
        "x-lark-signature": "s",
      },
      payload: { x: 1 },
      encryptKey: "secret",
    }),
    false
  )
})

test("uses timingSafeEqual: same-length wrong signature still false", () => {
  const wrong = "0".repeat(64)
  assert.equal(
    verifyFeishuWebhookSignature({
      headers: {
        "x-lark-request-timestamp": "t",
        "x-lark-request-nonce": "n",
        "x-lark-signature": wrong,
      },
      payload: { x: 1 },
      encryptKey: "k",
    }),
    false
  )
})
