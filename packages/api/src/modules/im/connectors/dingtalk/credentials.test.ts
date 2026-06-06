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
    { clientId: "ding-x", clientSecret: "sec-x" },
    "long_connection"
  )
  assert.equal(r.ok, true)
  assert.deepEqual(r.normalized, { clientId: "ding-x", clientSecret: "sec-x" })
})
