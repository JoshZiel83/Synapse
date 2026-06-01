import test from "node:test"
import assert from "node:assert/strict"

// The crypto module memoizes the passphrase on first use, so pin a stable key
// in the environment BEFORE importing it. (Import is dynamic for this reason.)
process.env.MCP_ENCRYPTION_KEY = "test-master-key-for-crypto-unit-tests"
const { encrypt, decrypt, isEncrypted, encryptSensitiveFields, secretsEqual } =
  await import("./index.js")

test("encrypt/decrypt round-trips, including unicode", () => {
  for (const plain of ["hello", "", "🔐 多字节 secret", "a".repeat(5000)]) {
    const enc = encrypt(plain)
    assert.equal(decrypt(enc), plain)
  }
})

test("envelope is versioned (enc:v2:) and recognized as encrypted", () => {
  const enc = encrypt("secret")
  assert.ok(enc.startsWith("enc:v2:"))
  assert.equal(isEncrypted(enc), true)
  assert.equal(isEncrypted("plain"), false)
})

test("same plaintext encrypts to different ciphertext (random salt+iv)", () => {
  const a = encrypt("same")
  const b = encrypt("same")
  assert.notEqual(a, b)
  assert.equal(decrypt(a), "same")
  assert.equal(decrypt(b), "same")
})

test("decrypt passes through non-encrypted values unchanged", () => {
  assert.equal(decrypt("not-encrypted"), "not-encrypted")
})

test("decrypt rejects an unknown envelope version", () => {
  assert.throws(() => decrypt("enc:v1:deadbeef"), /Unsupported encryption/)
})

test("decrypt rejects a malformed v2 envelope", () => {
  assert.throws(() => decrypt("enc:v2:onlytwo:parts"), /Invalid encrypted/)
})

test("tampering with the ciphertext fails authentication", () => {
  const enc = encrypt("secret")
  // Flip the last hex nibble of the ciphertext.
  const flipped = enc.slice(0, -1) + (enc.endsWith("0") ? "1" : "0")
  assert.throws(() => decrypt(flipped))
})

test("encryptSensitiveFields only encrypts schema-marked sensitive strings", () => {
  const schema = {
    properties: {
      apiKey: { sensitive: true },
      label: { sensitive: false },
    },
  }
  const out = encryptSensitiveFields({ apiKey: "shh", label: "public" }, schema)
  assert.ok(isEncrypted(out.apiKey as string))
  assert.equal(out.label, "public")
  // Idempotent: a second pass does not double-encrypt.
  const out2 = encryptSensitiveFields(out, schema)
  assert.equal(out2.apiKey, out.apiKey)
})

test("secretsEqual is correct and length-safe", () => {
  assert.equal(secretsEqual("abc", "abc"), true)
  assert.equal(secretsEqual("abc", "abd"), false)
  assert.equal(secretsEqual("abc", "abcd"), false)
  assert.equal(secretsEqual("", ""), true)
})
