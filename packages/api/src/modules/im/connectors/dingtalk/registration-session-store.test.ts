import test from "node:test"
import assert from "node:assert/strict"
import {
  parseDingtalkRegistrationSessionPayload,
  withDeviceCodeRedacted,
  type DingtalkRegistrationSession,
} from "./registration-session-store.js"

function fresh(
  patch: Partial<DingtalkRegistrationSession> = {}
): DingtalkRegistrationSession {
  return {
    sessionId: "sess",
    workspaceId: "ws",
    deviceCode: "dc-secret",
    verificationUriComplete: "https://example.com/uc?dc=1",
    expiresInSeconds: 600,
    intervalSeconds: 5,
    expiresAt: Date.now() + 600_000,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "waiting",
    pendingForm: {
      displayName: "DingBot",
      ownerScope: "workspace",
      ownerWorkspaceMemberId: null,
      inboundActorMode: "none",
      inboundActorId: null,
    },
    ...patch,
  }
}

test("withDeviceCodeRedacted: clears deviceCode, returns a new object", () => {
  const src = fresh({ status: "fail", deviceCode: "dc-secret" })
  const out = withDeviceCodeRedacted(src)
  assert.equal(out.deviceCode, "")
  // Source object is untouched (no mutation).
  assert.equal(src.deviceCode, "dc-secret")
  // Other fields preserved.
  assert.equal(out.status, "fail")
  assert.equal(out.sessionId, src.sessionId)
  assert.deepEqual(out.pendingForm, src.pendingForm)
})

test("withDeviceCodeRedacted: idempotent when already redacted", () => {
  const src = fresh({ deviceCode: "" })
  const out = withDeviceCodeRedacted(src)
  // No need to allocate a new object when there's nothing to change.
  assert.equal(out, src)
})

test("parseDingtalkRegistrationSessionPayload: accepts valid Redis payload", () => {
  const session = fresh({
    providerFailureCount: 2,
    lastProviderError: "timeout",
    lastProviderErrorAt: new Date().toISOString(),
  })
  assert.deepEqual(
    parseDingtalkRegistrationSessionPayload(JSON.stringify(session)),
    session
  )
})

test("parseDingtalkRegistrationSessionPayload: rejects malformed or drifted Redis payload", () => {
  assert.equal(parseDingtalkRegistrationSessionPayload("{not-json"), null)
  assert.equal(
    parseDingtalkRegistrationSessionPayload(
      JSON.stringify({ ...fresh(), status: "done" })
    ),
    null
  )
  assert.equal(
    parseDingtalkRegistrationSessionPayload(
      JSON.stringify({
        ...fresh(),
        pendingForm: {
          ...fresh().pendingForm!,
          ownerScope: "owner",
        },
      })
    ),
    null
  )
  assert.equal(
    parseDingtalkRegistrationSessionPayload(
      JSON.stringify({ ...fresh(), expiresAt: "soon" })
    ),
    null
  )
  for (const field of ["expiresAt", "createdAt", "updatedAt"] as const) {
    assert.equal(
      parseDingtalkRegistrationSessionPayload(
        JSON.stringify({ ...fresh(), [field]: -1 })
      ),
      null
    )
    assert.equal(
      parseDingtalkRegistrationSessionPayload(
        JSON.stringify({ ...fresh(), [field]: 1.5 })
      ),
      null
    )
  }
  assert.equal(
    parseDingtalkRegistrationSessionPayload(
      JSON.stringify({
        ...fresh(),
        lastProviderError: "timeout",
        lastProviderErrorAt: "2026-06-16T00:00:00Z",
      })
    ),
    null
  )
})
