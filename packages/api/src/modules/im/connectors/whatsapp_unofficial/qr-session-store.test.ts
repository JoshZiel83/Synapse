import test from "node:test"
import assert from "node:assert/strict"
import {
  parseWhatsappLoginSession,
  type WhatsappLoginSession,
} from "./qr-session-store.js"

function fresh(
  patch: Partial<WhatsappLoginSession> = {}
): WhatsappLoginSession {
  const now = Date.now()
  return {
    sessionId: "sess",
    workspaceId: "ws",
    status: "qr",
    qrDataUrl: "data:image/png;base64,AAAA",
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 60_000,
    ...patch,
  }
}

test("round-trips a valid session payload", () => {
  const session = fresh()
  const parsed = parseWhatsappLoginSession(JSON.stringify(session))
  assert.ok(parsed)
  assert.equal(parsed.status, "qr")
  assert.equal(parsed.qrDataUrl, session.qrDataUrl)
})

test("rejects malformed JSON", () => {
  assert.equal(parseWhatsappLoginSession("{not json"), null)
  assert.equal(parseWhatsappLoginSession(null), null)
})

test("rejects an unknown status (strict enum)", () => {
  const bad = { ...fresh(), status: "bogus" }
  assert.equal(parseWhatsappLoginSession(JSON.stringify(bad)), null)
})

test("rejects an extra field (strict schema)", () => {
  const bad = { ...fresh(), injected: true }
  assert.equal(parseWhatsappLoginSession(JSON.stringify(bad)), null)
})

test("accepts the linked terminal state with a transportAccountId", () => {
  const linked = fresh({
    status: "linked",
    qrDataUrl: undefined,
    transportAccountId: "acc-123",
  })
  const parsed = parseWhatsappLoginSession(JSON.stringify(linked))
  assert.ok(parsed)
  assert.equal(parsed.status, "linked")
  assert.equal(parsed.transportAccountId, "acc-123")
})
