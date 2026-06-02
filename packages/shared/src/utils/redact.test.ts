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

test("redacts the paired value of a sensitive {name,value} header entry", () => {
  const out = redactSecrets({
    headers: [
      { name: "authorization", value: "Bearer xyz" },
      { name: "content-type", value: "json" },
    ],
  })
  const headers = out.headers as any[]
  // The {name:"authorization", value:...} pair → its value is redacted even
  // though the literal key is "value". Non-sensitive header names pass through.
  assert.equal(headers[0].value, "***REDACTED***")
  assert.equal(headers[0].name, "authorization")
  assert.equal(headers[1].value, "json")
})

test("redacts key/value pair shape too (key:'authorization', value:...)", () => {
  const out = redactSecrets({
    params: [{ key: "authorization", value: "shh" }],
  })
  assert.equal((out.params as any[])[0].value, "***REDACTED***")
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

test("survives cyclic input AND redacts secrets in the revisited node", () => {
  const a: any = { token: "x" }
  a.self = a
  const out = redactSecrets(a)
  assert.equal(out.token, "***REDACTED***")
  // The cycle must resolve to the REDACTED copy, never the original object —
  // otherwise the revisited node would leak the raw secret.
  assert.equal(out.self.token, "***REDACTED***")
  assert.notEqual(out.self, a)
})

test("shared (non-cyclic) references are also redacted on revisit", () => {
  const shared: any = { token: "secret" }
  const out = redactSecrets({ a: shared, b: shared })
  assert.equal((out.a as any).token, "***REDACTED***")
  assert.equal((out.b as any).token, "***REDACTED***")
})

test("honors extra keys and custom placeholder", () => {
  const out = redactSecrets(
    { ssn: "123", name: "ok" },
    { extraKeys: ["ssn"], placeholder: "[hidden]" }
  )
  assert.equal(out.ssn, "[hidden]")
  assert.equal(out.name, "ok")
})

test("fails CLOSED at the depth limit (deep subtree is not leaked)", () => {
  // Build nesting deeper than maxDepth with a secret at the very bottom.
  const maxDepth = 4
  let deepest: any = { token: "secret" }
  for (let i = 0; i < maxDepth + 3; i++) deepest = { nested: deepest }
  const out = redactSecrets(deepest, { maxDepth })
  // Walk down to the cutoff: beyond maxDepth the subtree must be the
  // placeholder, never the raw { token: "secret" }.
  const serialized = JSON.stringify(out)
  assert.ok(
    !serialized.includes("secret"),
    `deep secret leaked past maxDepth: ${serialized}`
  )
  assert.ok(serialized.includes("***REDACTED***"))
})

test("default maxDepth also fails closed for very deep input", () => {
  let deepest: any = { token: "secret" }
  for (let i = 0; i < 40; i++) deepest = { nested: deepest }
  const serialized = JSON.stringify(redactSecrets(deepest))
  assert.ok(
    !serialized.includes("secret"),
    "deep secret leaked at default depth"
  )
})
