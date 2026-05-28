import test from "node:test"
import assert from "node:assert/strict"
import {
  extractQqCredentials,
  getEd25519Seed,
  getQqCredentialsOrThrow,
  validateQqCredentialsForMode,
} from "./credentials.js"

test("extractQqCredentials: snake_case + camelCase + secret alias", () => {
  const camel = extractQqCredentials({ appId: "X", clientSecret: "Y" })
  assert.deepEqual(camel.credentials, { appId: "X", clientSecret: "Y" })
  const snake = extractQqCredentials({ app_id: "X", client_secret: "Y" })
  assert.deepEqual(snake.credentials, { appId: "X", clientSecret: "Y" })
  const aliased = extractQqCredentials({ app_id: "X", secret: "Y" })
  assert.deepEqual(aliased.credentials, { appId: "X", clientSecret: "Y" })
})

test("extractQqCredentials: missing fields surface errors", () => {
  const onlyApp = extractQqCredentials({ appId: "X" })
  assert.deepEqual(onlyApp.errors, ["clientSecret is required"])
  assert.equal(onlyApp.credentials, undefined)
  const empty = extractQqCredentials({})
  assert.equal(empty.errors.length, 2)
})

test("extractQqCredentials: botSecret is optional (alias supported)", () => {
  const withBot = extractQqCredentials({
    appId: "X",
    clientSecret: "Y",
    bot_secret: "Z",
  })
  assert.deepEqual(withBot.credentials, {
    appId: "X",
    clientSecret: "Y",
    botSecret: "Z",
  })
})

test("validateQqCredentialsForMode: rejects unknown connection_mode", () => {
  const r = validateQqCredentialsForMode(
    { appId: "X", clientSecret: "Y" },
    "smtp"
  )
  assert.equal(r.ok, false)
  assert.ok(r.errors[0].includes("qq supports"))
})

test("validateQqCredentialsForMode: accepts webhook + long_connection", () => {
  for (const mode of ["webhook", "long_connection"] as const) {
    const r = validateQqCredentialsForMode(
      { appId: "X", clientSecret: "Y" },
      mode
    )
    assert.equal(r.ok, true)
    assert.deepEqual(r.normalized, { appId: "X", clientSecret: "Y" })
  }
})

test("getQqCredentialsOrThrow throws with clear message on missing fields", () => {
  assert.throws(
    () => getQqCredentialsOrThrow({ credentials: { appId: "X" } }),
    /clientSecret is required/
  )
})

test("getEd25519Seed: uses botSecret when present, falls back to clientSecret (OQ1 default)", () => {
  assert.equal(
    getEd25519Seed({ appId: "X", clientSecret: "C", botSecret: "B" }),
    "B"
  )
  assert.equal(getEd25519Seed({ appId: "X", clientSecret: "C" }), "C")
})
