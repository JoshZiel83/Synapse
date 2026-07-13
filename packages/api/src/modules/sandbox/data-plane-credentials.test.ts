// (R4 §1.3/§6.7) Off-box data-plane credential envelope + F7 degrade + redaction.
// Reuses the app secret-box (AES-256-GCM under MCP_ENCRYPTION_KEY) with the AAD
// bound to the sandbox row identity. No DB, no live cube — pure crypto/branding.
//
// GATE tests (task item): the encrypt→persist→decrypt→re-inject ROUND-TRIP, and
// the F7 decrypt-MISS-degrades-to-null (rotated key / tampered AAD / corrupt).

import test from "node:test"
import assert from "node:assert/strict"
import { inspect } from "node:util"
import {
  brandRedactedCredentials,
  decodeSandboxDataPlaneCredentials,
  encodeSandboxDataPlaneCredentials,
  hasAnyToken,
  tokensForEnvd,
} from "./data-plane-credentials.js"

const BINDING = { sandboxRowId: "rt-A", workspaceId: "ws-1" }
const FAKE = {
  envdAccessToken: "envd-tok-XYZ",
  trafficAccessToken: "traf-tok-QRS",
}

test("round-trip: encrypt → persist → decrypt → re-inject the SAME tokens", () => {
  const envelope = encodeSandboxDataPlaneCredentials(FAKE, BINDING)
  assert.ok(envelope, "creds with tokens must produce a non-null envelope")
  assert.ok(
    envelope!.startsWith("enc:b1:"),
    "envelope is the base64 AES-256-GCM (enc:b1:) shape"
  )
  // The plaintext tokens must NOT appear in the ciphertext.
  assert.ok(!envelope!.includes(FAKE.envdAccessToken))
  assert.ok(!envelope!.includes(FAKE.trafficAccessToken))

  const decoded = decodeSandboxDataPlaneCredentials(envelope, BINDING)
  assert.ok(decoded, "same binding decrypts")
  assert.equal(decoded!.envdAccessToken, FAKE.envdAccessToken)
  assert.equal(decoded!.trafficAccessToken, FAKE.trafficAccessToken)
  // Re-inject shape the envd factory consumes.
  assert.deepEqual(tokensForEnvd(decoded), {
    envdAccessToken: FAKE.envdAccessToken,
    trafficAccessToken: FAKE.trafficAccessToken,
  })
})

test("F7: decrypt MISS degrades to null (tampered AAD = blob swapped onto another row)", () => {
  const envelope = encodeSandboxDataPlaneCredentials(FAKE, BINDING)
  assert.ok(envelope)
  // Same key, DIFFERENT row id → the AAD no longer matches → GCM tag fails →
  // null (NOT a throw, NOT a hard-deny). This is the anti-swap property (§6.7/3b)
  // AND the F7 degrade in one: an attacker pasting row A's blob onto row B gets
  // credentials=null → the reconnect re-mint heals it.
  const swapped = decodeSandboxDataPlaneCredentials(envelope, {
    sandboxRowId: "rt-B",
    workspaceId: "ws-1",
  })
  assert.equal(swapped, null, "wrong-row AAD → null (F7 degrade)")

  const wrongWs = decodeSandboxDataPlaneCredentials(envelope, {
    sandboxRowId: "rt-A",
    workspaceId: "ws-OTHER",
  })
  assert.equal(wrongWs, null, "wrong-workspace AAD → null")
})

test("F7: corrupt / non-envelope ciphertext degrades to null (never throws)", () => {
  assert.equal(
    decodeSandboxDataPlaneCredentials("enc:b1:not-valid-base64!!!", BINDING),
    null
  )
  assert.equal(
    decodeSandboxDataPlaneCredentials("enc:b1:AAAA", BINDING),
    null,
    "too-short envelope → null"
  )
  assert.equal(
    decodeSandboxDataPlaneCredentials("plaintext-not-an-envelope", BINDING),
    null
  )
  assert.equal(decodeSandboxDataPlaneCredentials(null, BINDING), null)
})

test("no-secret bags encode to null (host/resident + unauthenticated local cube)", () => {
  assert.equal(encodeSandboxDataPlaneCredentials(null, BINDING), null)
  assert.equal(encodeSandboxDataPlaneCredentials({}, BINDING), null)
  assert.equal(
    encodeSandboxDataPlaneCredentials(
      { envdAccessToken: undefined, trafficAccessToken: undefined },
      BINDING
    ),
    null
  )
  assert.equal(hasAnyToken(null), false)
  assert.equal(hasAnyToken({}), false)
  assert.equal(hasAnyToken(FAKE), true)
})

test("redaction (§6.7/3d): branded creds don't leak through JSON / inspect but stay readable", () => {
  const branded = brandRedactedCredentials(FAKE)
  // Readable BY NAME (the envd factory + encrypt path read these).
  assert.equal(branded.envdAccessToken, FAKE.envdAccessToken)
  assert.equal(branded.trafficAccessToken, FAKE.trafficAccessToken)
  // Non-enumerable — Object.keys / spread see nothing.
  assert.deepEqual(Object.keys(branded), [])
  assert.deepEqual({ ...branded }, {})
  // JSON.stringify (direct AND nested under a handle) redacts.
  const asJson = JSON.stringify({ handle: { credentials: branded } })
  assert.ok(!asJson.includes(FAKE.envdAccessToken), "no token in JSON")
  assert.ok(!asJson.includes(FAKE.trafficAccessToken))
  assert.ok(asJson.includes("redacted"))
  // util.inspect (pino/console path) redacts.
  const asInspect = inspect({ credentials: branded }, { depth: 5 })
  assert.ok(!asInspect.includes(FAKE.envdAccessToken), "no token in inspect")
  assert.ok(asInspect.includes("redacted"))
  // A branded bag still round-trips through encrypt (reads fields, not toJSON).
  const env = encodeSandboxDataPlaneCredentials(branded, BINDING)
  const back = decodeSandboxDataPlaneCredentials(env, BINDING)
  assert.equal(back!.envdAccessToken, FAKE.envdAccessToken)
})
