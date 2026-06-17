/**
 * Tests for the Feishu webhook URL-verification handshake.
 *
 * Regression coverage for two bugs:
 *   1. The challenge reply was double-nested ({ challenge: { challenge } })
 *      instead of the single-level { challenge } Feishu requires.
 *   2. Encrypt-Key mode (body = { encrypt }) was never recognized as a
 *      challenge, so encrypted apps could never complete verification.
 */

import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { handleFeishuWebhook } from "./inbound.js"

function fakeAccount(credentials: Record<string, unknown>): any {
  return {
    id: "acc_test",
    transportKind: "feishu",
    connectionMode: "webhook",
    credentials,
  }
}

const noopEmit = async () => {}

test("URL verification (plaintext): reply is single-level { challenge }", async () => {
  const result = await handleFeishuWebhook({
    account: fakeAccount({ appId: "cli_x", appSecret: "secret_x" }),
    headers: {},
    body: { type: "url_verification", challenge: "plain-chal-1", token: "vt" },
    emitInbound: noopEmit,
  } as any)

  assert.equal(result.statusCode, 200)
  // Must be exactly { challenge: "plain-chal-1" } — NOT { challenge: { challenge } }.
  assert.deepEqual(result.body, { challenge: "plain-chal-1" })
})

test("URL verification (Encrypt-Key): decrypts {encrypt} and replies with the challenge", async () => {
  const encryptKey = "test-encrypt-key"
  const plaintext = JSON.stringify({
    type: "url_verification",
    challenge: "enc-chal-2",
    token: "vt",
  })
  // Mirror the SDK's AES layout: key = sha256(encryptKey), iv = first 16
  // bytes of the payload, aes-256-cbc (PKCS7 padding by default).
  const key = crypto.createHash("sha256").update(encryptKey).digest()
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv)
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ])
  const encrypt = Buffer.concat([iv, encrypted]).toString("base64")

  const result = await handleFeishuWebhook({
    account: fakeAccount({ appId: "cli_x", appSecret: "secret_x", encryptKey }),
    headers: {},
    body: { encrypt },
    emitInbound: noopEmit,
  } as any)

  assert.equal(result.statusCode, 200)
  assert.deepEqual(result.body, { challenge: "enc-chal-2" })
})
