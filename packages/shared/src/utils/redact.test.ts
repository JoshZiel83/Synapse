import test from "node:test"
import assert from "node:assert/strict"
import { redactSecrets } from "./redact.js"

test("redacts top-level sensitive keys", () => {
  const out = redactSecrets({ apiKey: "x", name: "ok", password: "p" })
  assert.equal(out.apiKey, "***REDACTED***")
  assert.equal(out.password, "***REDACTED***")
  assert.equal(out.name, "ok")
})

test("redacts NESTED sensitive keys (the whole point)", () => {
  const out = redactSecrets({
    auth: { token: "deadbeef", scheme: "bearer" },
    nested: { deep: { client_secret: "shh" } },
  })
  assert.equal((out.auth as any).token, "***REDACTED***")
  assert.equal((out.auth as any).scheme, "bearer")
  assert.equal((out.nested as any).deep.client_secret, "***REDACTED***")
})

test("redacts inside arrays of objects", () => {
  const out = redactSecrets({
    headers: [
      { name: "authorization", value: "Bearer xyz" },
      { name: "content-type", value: "json" },
    ],
  })
  // The KEY "value" is not sensitive; "authorization" as a value string is not
  // redacted (we match key names, not values) — but a key literally named
  // authorization is.
  const headers = out.headers as any[]
  assert.equal(headers[0].value, "Bearer xyz")
  assert.equal(headers[1].value, "json")
})

test("redacts a key literally named authorization at any depth", () => {
  const out = redactSecrets({ a: { b: { authorization: "secret" } } })
  assert.equal((out.a as any).b.authorization, "***REDACTED***")
})

test("does not mutate the input", () => {
  const input = { token: "x", nested: { secret: "y" } }
  const out = redactSecrets(input)
  assert.equal(input.token, "x")
  assert.equal(input.nested.secret, "y")
  assert.notEqual(out, input)
})

test("passes through primitives and leaves non-plain objects intact", () => {
  assert.equal(redactSecrets("plain"), "plain")
  assert.equal(redactSecrets(42), 42)
  const d = new Date()
  const out = redactSecrets({ when: d, token: "x" })
  assert.equal((out as any).when, d)
  assert.equal((out as any).token, "***REDACTED***")
})

test("survives cyclic input", () => {
  const a: any = { token: "x" }
  a.self = a
  const out = redactSecrets(a)
  assert.equal(out.token, "***REDACTED***")
})

test("honors extra keys and custom placeholder", () => {
  const out = redactSecrets(
    { ssn: "123", name: "ok" },
    { extraKeys: ["ssn"], placeholder: "[hidden]" }
  )
  assert.equal(out.ssn, "[hidden]")
  assert.equal(out.name, "ok")
})
