import test from "node:test"
import assert from "node:assert/strict"
import {
  extractFeishuCredentials,
  validateFeishuCredentialsForMode,
} from "./credentials.js"

test("accepts canonical appId/appSecret", () => {
  const r = extractFeishuCredentials({ appId: "cli_x", appSecret: "s" })
  assert.equal(r.errors.length, 0)
  assert.equal(r.credentials?.appId, "cli_x")
  assert.equal(r.credentials?.appSecret, "s")
})

test("accepts legacy aliases (appID/cliAppId/app_secret)", () => {
  const r = extractFeishuCredentials({
    appID: "cli_y",
    cliAppSecret: "secret",
  })
  assert.equal(r.credentials?.appId, "cli_y")
  assert.equal(r.credentials?.appSecret, "secret")
})

test("reports missing required fields", () => {
  const r = extractFeishuCredentials({})
  assert.ok(r.errors.includes("appId is required"))
  assert.ok(r.errors.includes("appSecret is required"))
})

test("webhook mode requires encryptKey", () => {
  const r = validateFeishuCredentialsForMode(
    { appId: "x", appSecret: "y" },
    "webhook"
  )
  assert.equal(r.ok, false)
  assert.ok(r.errors[0].includes("encryptKey"))
})

test("webhook mode ok when encryptKey present", () => {
  const r = validateFeishuCredentialsForMode(
    { appId: "x", appSecret: "y", encryptKey: "k", verificationToken: "v" },
    "webhook"
  )
  assert.equal(r.ok, true)
  assert.equal(r.normalized?.encryptKey, "k")
})

test("long_connection mode ok without encryptKey", () => {
  const r = validateFeishuCredentialsForMode(
    { appId: "x", appSecret: "y" },
    "long_connection"
  )
  assert.equal(r.ok, true)
})

test("whitespace-only credentials treated as missing", () => {
  const r = extractFeishuCredentials({ appId: "   ", appSecret: "  " })
  assert.equal(r.errors.length, 2)
})
