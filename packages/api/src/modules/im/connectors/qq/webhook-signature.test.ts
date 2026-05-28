import test from "node:test"
import assert from "node:assert/strict"
import {
  extractSignatureHeaders,
  signEd25519UrlVerification,
  verifyEd25519BusinessEvent,
} from "./webhook-signature.js"

const SECRET = "DG5g3B4j9X2KOErG"

test("URL-verification signature is deterministic", () => {
  const sig = signEd25519UrlVerification({
    secret: SECRET,
    plainToken: "Arq0D5A61EgUu4OxUvOp",
    eventTs: "1725442341",
  })
  const sig2 = signEd25519UrlVerification({
    secret: SECRET,
    plainToken: "Arq0D5A61EgUu4OxUvOp",
    eventTs: "1725442341",
  })
  assert.equal(sig, sig2)
  assert.equal(
    sig.length,
    128,
    "ed25519 signature must be 64 bytes / 128 hex chars"
  )
})

test("URL-verification + business-event sign/verify roundtrip with same seed", () => {
  // Sign as if we were the platform: encode timestamp + raw body with
  // the same algorithm so our verifier accepts it.
  const ts = "1725442341"
  const body = '{"op":0,"t":"C2C_MESSAGE_CREATE","s":1,"d":{}}'
  // signEd25519UrlVerification works for arbitrary (event_ts, plain_token)
  // pairs; signature is over event_ts+plain_token. Reuse with
  // (timestamp, rawBody) to produce a platform-style signature.
  const sigHex = signEd25519UrlVerification({
    secret: SECRET,
    plainToken: body,
    eventTs: ts,
  })
  const ok = verifyEd25519BusinessEvent({
    secret: SECRET,
    signatureHex: sigHex,
    timestamp: ts,
    rawBody: body,
  })
  assert.equal(ok, true)
})

test("verify fails when raw body is tampered", () => {
  const ts = "1725442341"
  const body = '{"op":0,"d":{"a":1}}'
  const sigHex = signEd25519UrlVerification({
    secret: SECRET,
    plainToken: body,
    eventTs: ts,
  })
  const ok = verifyEd25519BusinessEvent({
    secret: SECRET,
    signatureHex: sigHex,
    timestamp: ts,
    rawBody: '{"op":0,"d":{"a":2}}',
  })
  assert.equal(ok, false)
})

test("verify fails on bad signature hex / wrong length", () => {
  for (const bad of ["", "not-hex", "ab", "ff".repeat(32)]) {
    const ok = verifyEd25519BusinessEvent({
      secret: SECRET,
      signatureHex: bad,
      timestamp: "1",
      rawBody: "x",
    })
    assert.equal(ok, false, `unexpected accept for ${bad}`)
  }
})

test("seed-shorter-than-32 path repeats the secret to 32 bytes", () => {
  // Sanity: signing with a short secret must not throw and must
  // produce a 64-byte signature.
  const sig = signEd25519UrlVerification({
    secret: "short",
    plainToken: "t",
    eventTs: "0",
  })
  assert.equal(sig.length, 128)
})

test("extractSignatureHeaders handles lowercase + canonical + array forms", () => {
  assert.deepEqual(
    extractSignatureHeaders({
      "x-signature-ed25519": "abc",
      "x-signature-timestamp": "1",
    }),
    { signatureHex: "abc", timestamp: "1" }
  )
  assert.deepEqual(
    extractSignatureHeaders({
      "X-Signature-Ed25519": ["abc", "other"],
      "X-Signature-Timestamp": "1",
    }),
    { signatureHex: "abc", timestamp: "1" }
  )
  assert.deepEqual(extractSignatureHeaders({}), {
    signatureHex: undefined,
    timestamp: undefined,
  })
})
