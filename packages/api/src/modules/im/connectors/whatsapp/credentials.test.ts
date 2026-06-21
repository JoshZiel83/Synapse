import test from "node:test"
import assert from "node:assert/strict"
import {
  extractWhatsappCredentials,
  getWhatsappCredentialsOrThrow,
  validateWhatsappCredentialsForMode,
} from "./credentials.js"
import { WHATSAPP_DEFAULT_GRAPH_VERSION } from "./types.js"

const FULL = {
  phoneNumberId: "123",
  wabaId: "456",
  accessToken: "tok",
  appSecret: "sec",
  appId: "789",
  webhookVerifyToken: "verify",
}

test("validateWhatsappCredentialsForMode: webhook + full creds → ok with default graph version", () => {
  const r = validateWhatsappCredentialsForMode(FULL, "webhook")
  assert.equal(r.ok, true)
  assert.equal(r.normalized?.graphApiVersion, WHATSAPP_DEFAULT_GRAPH_VERSION)
  assert.equal(r.normalized?.phoneNumberId, "123")
})

test("validateWhatsappCredentialsForMode: non-webhook mode is rejected", () => {
  for (const mode of ["long_connection", "polling", ""]) {
    const r = validateWhatsappCredentialsForMode(FULL, mode)
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => e.includes("webhook")))
  }
})

test("validateWhatsappCredentialsForMode: missing fields are reported", () => {
  const r = validateWhatsappCredentialsForMode(
    { phoneNumberId: "123" },
    "webhook"
  )
  assert.equal(r.ok, false)
  assert.ok(r.errors.includes("accessToken is required"))
  assert.ok(r.errors.includes("appSecret is required"))
  assert.ok(r.errors.includes("webhookVerifyToken is required"))
})

test("extractWhatsappCredentials: normalizes graph version (adds v prefix, validates shape)", () => {
  assert.equal(
    extractWhatsappCredentials({ ...FULL, graphApiVersion: "22.0" }).credentials
      ?.graphApiVersion,
    "v22.0"
  )
  assert.equal(
    extractWhatsappCredentials({ ...FULL, graphApiVersion: "v19.0" })
      .credentials?.graphApiVersion,
    "v19.0"
  )
  // Garbage version falls back to the default rather than building a broken URL.
  assert.equal(
    extractWhatsappCredentials({ ...FULL, graphApiVersion: "not-a-version" })
      .credentials?.graphApiVersion,
    WHATSAPP_DEFAULT_GRAPH_VERSION
  )
})

test("getWhatsappCredentialsOrThrow: throws on missing creds", () => {
  assert.throws(
    () => getWhatsappCredentialsOrThrow({ credentials: {} }),
    /WhatsApp credentials invalid/
  )
  assert.equal(
    getWhatsappCredentialsOrThrow({ credentials: FULL }).appId,
    "789"
  )
})
