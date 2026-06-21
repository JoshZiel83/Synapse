import test from "node:test"
import assert from "node:assert/strict"
import {
  extractTelegramCredentials,
  getTelegramCredentialsOrThrow,
  resolveApiRoot,
  validateTelegramCredentialsForMode,
} from "./credentials.js"
import { TELEGRAM_API_ROOT } from "./types.js"

test("extractTelegramCredentials: botToken canonical", () => {
  const r = extractTelegramCredentials({ botToken: "123:ABC" })
  assert.deepEqual(r.credentials, { botToken: "123:ABC" })
  assert.deepEqual(r.errors, [])
})

test("extractTelegramCredentials: missing botToken errors", () => {
  const r = extractTelegramCredentials({})
  assert.deepEqual(r.errors, ["botToken is required"])
  assert.equal(r.credentials, undefined)
})

test("extractTelegramCredentials: optional fields + apiRoot trailing slash trim", () => {
  const r = extractTelegramCredentials({
    botToken: "t",
    webhookSecretToken: "s",
    apiRoot: "https://local.example/",
  })
  assert.deepEqual(r.credentials, {
    botToken: "t",
    webhookSecretToken: "s",
    apiRoot: "https://local.example",
  })
})

test("validateTelegramCredentialsForMode: rejects unknown mode", () => {
  const r = validateTelegramCredentialsForMode({ botToken: "t" }, "smtp")
  assert.equal(r.ok, false)
  assert.ok(r.errors[0].includes("telegram supports"))
})

test("validateTelegramCredentialsForMode: long_connection ok without secret", () => {
  const r = validateTelegramCredentialsForMode(
    { botToken: "t" },
    "long_connection"
  )
  assert.equal(r.ok, true)
  assert.deepEqual(r.normalized, { botToken: "t" })
})

test("validateTelegramCredentialsForMode: webhook requires secret token", () => {
  const missing = validateTelegramCredentialsForMode(
    { botToken: "t" },
    "webhook"
  )
  assert.equal(missing.ok, false)
  assert.ok(missing.errors[0].includes("webhookSecretToken"))

  const ok = validateTelegramCredentialsForMode(
    { botToken: "t", webhookSecretToken: "s" },
    "webhook"
  )
  assert.equal(ok.ok, true)
})

test("getTelegramCredentialsOrThrow throws on missing", () => {
  assert.throws(
    () => getTelegramCredentialsOrThrow({ credentials: {} }),
    /botToken is required/
  )
})

test("resolveApiRoot: default cloud, custom override", () => {
  assert.equal(resolveApiRoot({ botToken: "t" }), TELEGRAM_API_ROOT)
  assert.equal(
    resolveApiRoot({ botToken: "t", apiRoot: "https://x.example" }),
    "https://x.example"
  )
})
