import test from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_WEIXIN_BASE_URL,
  extractWeixinCredentials,
  validateWeixinCredentialsForMode,
} from "./credentials.js"

test("extracts token + applies default baseUrl", () => {
  const r = extractWeixinCredentials({ token: "tk_x" }, {})
  assert.equal(r.errors.length, 0)
  assert.equal(r.credentials?.token, "tk_x")
  assert.equal(r.credentials?.baseUrl, DEFAULT_WEIXIN_BASE_URL)
})

test("config baseUrl wins over default", () => {
  const r = extractWeixinCredentials(
    { token: "tk_x" },
    { baseUrl: "https://custom.example.com" }
  )
  assert.equal(r.credentials?.baseUrl, "https://custom.example.com")
})

test("missing token is an error", () => {
  const r = extractWeixinCredentials({}, {})
  assert.ok(r.errors[0].includes("token"))
  assert.equal(r.credentials, undefined)
})

test("whitespace token counts as missing", () => {
  const r = extractWeixinCredentials({ token: "   " }, {})
  assert.ok(r.errors[0].includes("token"))
})

test("validate rejects webhook mode", () => {
  const r = validateWeixinCredentialsForMode({ token: "tk" }, "webhook")
  assert.equal(r.ok, false)
  assert.ok(r.errors[0].includes("long_connection"))
})

test("validate accepts long_connection + valid creds", () => {
  const r = validateWeixinCredentialsForMode(
    { token: "tk" },
    "long_connection",
    {}
  )
  assert.equal(r.ok, true)
  assert.equal(r.normalized?.token, "tk")
})
