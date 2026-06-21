import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import {
  computeWhatsappSignature,
  extractWhatsappSignatureHeader,
  verifyWhatsappSignature,
} from "./webhook-signature.js"

const SECRET = "app-secret-xyz"
// A body with escaped-Unicode (the exact bytes matter — re-serializing would
// change them and flip the HMAC).
const RAW_BODY =
  '{"object":"whatsapp_business_account","entry":[{"text":"caf\\u00e9 \\ud83d\\ude00"}]}'

function sign(body: string): string {
  const hex = crypto
    .createHmac("sha256", SECRET)
    .update(body, "utf8")
    .digest("hex")
  return `sha256=${hex}`
}

test("verifyWhatsappSignature: accepts a correct signature over the raw body", () => {
  const header = sign(RAW_BODY)
  assert.equal(
    verifyWhatsappSignature({
      appSecret: SECRET,
      rawBody: RAW_BODY,
      signatureHeader: header,
    }),
    true
  )
})

test("verifyWhatsappSignature: computeWhatsappSignature matches the manual HMAC", () => {
  assert.equal(
    computeWhatsappSignature({ appSecret: SECRET, rawBody: RAW_BODY }),
    sign(RAW_BODY)
  )
})

test("verifyWhatsappSignature: rejects a tampered body", () => {
  const header = sign(RAW_BODY)
  assert.equal(
    verifyWhatsappSignature({
      appSecret: SECRET,
      rawBody: `${RAW_BODY} `,
      signatureHeader: header,
    }),
    false
  )
})

test("verifyWhatsappSignature: rejects missing / malformed headers", () => {
  for (const header of [
    undefined,
    "",
    "deadbeef", // no prefix
    `sha1=${crypto.createHmac("sha1", SECRET).update(RAW_BODY).digest("hex")}`,
    "sha256=short",
  ]) {
    assert.equal(
      verifyWhatsappSignature({
        appSecret: SECRET,
        rawBody: RAW_BODY,
        signatureHeader: header,
      }),
      false,
      `header=${header}`
    )
  }
})

test("verifyWhatsappSignature: wrong secret fails", () => {
  assert.equal(
    verifyWhatsappSignature({
      appSecret: "different",
      rawBody: RAW_BODY,
      signatureHeader: sign(RAW_BODY),
    }),
    false
  )
})

test("extractWhatsappSignatureHeader: tolerates casing + array values", () => {
  assert.equal(
    extractWhatsappSignatureHeader({ "x-hub-signature-256": "sha256=abc" }),
    "sha256=abc"
  )
  assert.equal(
    extractWhatsappSignatureHeader({ "X-Hub-Signature-256": "sha256=def" }),
    "sha256=def"
  )
  assert.equal(
    extractWhatsappSignatureHeader({ "x-hub-signature-256": ["sha256=g"] }),
    "sha256=g"
  )
  assert.equal(extractWhatsappSignatureHeader({}), undefined)
})
