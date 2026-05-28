import test from "node:test"
import assert from "node:assert/strict"
import {
  extractDingtalkCredentials,
  validateDingtalkCredentialsForMode,
} from "./credentials.js"

test("extractDingtalkCredentials: missing fields produce errors", () => {
  const { credentials, errors } = extractDingtalkCredentials({})
  assert.equal(credentials, undefined)
  assert.deepEqual(errors.sort(), [
    "clientId is required",
    "clientSecret is required",
  ])
})

test("extractDingtalkCredentials: canonical fields pass through", () => {
  const { credentials, errors } = extractDingtalkCredentials({
    clientId: "ding-xxx",
    clientSecret: "secret-yyy",
  })
  assert.deepEqual(errors, [])
  assert.deepEqual(credentials, {
    clientId: "ding-xxx",
    clientSecret: "secret-yyy",
  })
})

test("extractDingtalkCredentials: alias forms (snake_case, AppKey) merge", () => {
  const r1 = extractDingtalkCredentials({
    client_id: "ding-1",
    client_secret: "sec-1",
  })
  assert.deepEqual(r1.credentials, {
    clientId: "ding-1",
    clientSecret: "sec-1",
  })

  const r2 = extractDingtalkCredentials({
    AppKey: "ding-2",
    AppSecret: "sec-2",
  })
  assert.deepEqual(r2.credentials, {
    clientId: "ding-2",
    clientSecret: "sec-2",
  })

  const r3 = extractDingtalkCredentials({
    appKey: "ding-3",
    appSecret: "sec-3",
  })
  assert.deepEqual(r3.credentials, {
    clientId: "ding-3",
    clientSecret: "sec-3",
  })
})

test("extractDingtalkCredentials: blank/whitespace are treated as missing", () => {
  const { errors } = extractDingtalkCredentials({
    clientId: "   ",
    clientSecret: "",
  })
  assert.deepEqual(errors.sort(), [
    "clientId is required",
    "clientSecret is required",
  ])
})

test("validateDingtalkCredentialsForMode: webhook mode is rejected in v1", () => {
  const r = validateDingtalkCredentialsForMode(
    { clientId: "x", clientSecret: "y" },
    "webhook"
  )
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((m) => m.includes("only supports long_connection")))
})

test("validateDingtalkCredentialsForMode: long_connection happy path returns normalized", () => {
  const r = validateDingtalkCredentialsForMode(
    { appKey: "ding-x", appSecret: "sec-x" },
    "long_connection"
  )
  assert.equal(r.ok, true)
  assert.deepEqual(r.normalized, { clientId: "ding-x", clientSecret: "sec-x" })
})
