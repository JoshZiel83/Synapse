/**
 * WeCom controller schema tests.
 *
 * These cover the API-boundary guards that the service layer can't see:
 *   - `.strict()`: unknown keys (e.g. `accountKey` on update — which
 *     `updateTransportAccount` ignores) now produce a 400 instead of
 *     a misleading 200 + silent no-op + runtime refresh.
 *   - `baseWsUrl` refinement: SDK gets passed this verbatim, so we
 *     reject non-`ws(s)://` URLs at the boundary instead of letting the
 *     connect fail with a less actionable error later.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { updateWecomAccountSchema, wecomAccountSchema } from "./_shared.js"

const validCreate = {
  displayName: "WeCom Bot",
  botId: "bot-1",
  secret: "secret-1",
}

test("wecomAccountSchema accepts a minimal valid create body", () => {
  const result = wecomAccountSchema.safeParse(validCreate)
  assert.equal(result.success, true)
  if (result.success) {
    // connectionMode defaults to long_connection
    assert.equal(result.data.connectionMode, "long_connection")
  }
})

test("wecomAccountSchema rejects unknown keys (strict mode)", () => {
  const result = wecomAccountSchema.safeParse({
    ...validCreate,
    // Plausible typo / hostile input. Without `.strict()`, Zod's default
    // `strip` mode would silently drop this key and return success.
    randomGarbage: "should be rejected",
  })
  assert.equal(result.success, false)
  if (!result.success) {
    assert.ok(
      result.error.issues.some((issue) =>
        issue.message.toLowerCase().includes("unrecognized")
      ),
      "expected an 'unrecognized key' issue from .strict()"
    )
  }
})

test("updateWecomAccountSchema rejects accountKey (dead-field guard)", () => {
  // The dead-field that motivated this whole guard: `updateTransportAccount`
  // doesn't accept `accountKey`, so accepting it here would silently 200.
  const result = updateWecomAccountSchema.safeParse({
    accountKey: "new-key-attempt",
  })
  assert.equal(result.success, false)
})

test("updateWecomAccountSchema accepts an empty body (all fields optional)", () => {
  const result = updateWecomAccountSchema.safeParse({})
  assert.equal(result.success, true)
})

test("updateWecomAccountSchema accepts baseWsUrl: null (explicit clear)", () => {
  // `null` means "clear the previously-saved baseWsUrl". The controller
  // translates this to a `config: {}` write so service overwrites the
  // existing JSONB instead of preserving the stale value.
  const result = updateWecomAccountSchema.safeParse({ baseWsUrl: null })
  assert.equal(result.success, true)
  if (result.success) {
    assert.equal(result.data.baseWsUrl, null)
  }
})

test("updateWecomAccountSchema still validates string baseWsUrl when set", () => {
  // The .nullable() addition must not weaken the scheme refinement —
  // sending a non-ws(s):// string should still be rejected.
  const ok = updateWecomAccountSchema.safeParse({
    baseWsUrl: "wss://example.com",
  })
  assert.equal(ok.success, true)
  const bad = updateWecomAccountSchema.safeParse({
    baseWsUrl: "http://example.com",
  })
  assert.equal(bad.success, false)
})

test("updateWecomAccountSchema accepts partial updates of supported fields", () => {
  const result = updateWecomAccountSchema.safeParse({
    displayName: "Renamed Bot",
    botId: "bot-2",
    secret: "secret-2",
    baseWsUrl: "wss://openws.work.weixin.qq.com",
  })
  assert.equal(result.success, true)
})

test("baseWsUrl accepts wss:// (production scheme)", () => {
  const result = wecomAccountSchema.safeParse({
    ...validCreate,
    baseWsUrl: "wss://openws.work.weixin.qq.com",
  })
  assert.equal(result.success, true)
})

test("baseWsUrl accepts ws:// (dev gateway escape hatch)", () => {
  const result = wecomAccountSchema.safeParse({
    ...validCreate,
    baseWsUrl: "ws://localhost:9000/ws",
  })
  assert.equal(result.success, true)
})

test("baseWsUrl rejects http://", () => {
  const result = wecomAccountSchema.safeParse({
    ...validCreate,
    baseWsUrl: "http://example.com",
  })
  assert.equal(result.success, false)
})

test("baseWsUrl rejects https://", () => {
  const result = wecomAccountSchema.safeParse({
    ...validCreate,
    baseWsUrl: "https://example.com",
  })
  assert.equal(result.success, false)
})

test("baseWsUrl rejects ftp:// and other schemes", () => {
  for (const url of [
    "ftp://example.com",
    "tcp://example.com:9000",
    "file:///tmp/sock",
  ]) {
    const result = wecomAccountSchema.safeParse({
      ...validCreate,
      baseWsUrl: url,
    })
    assert.equal(result.success, false, `${url} should be rejected`)
  }
})

test("baseWsUrl rejects malformed strings (not a URL)", () => {
  const result = wecomAccountSchema.safeParse({
    ...validCreate,
    baseWsUrl: "openws.work.weixin.qq.com",
  })
  assert.equal(result.success, false)
})

test("baseWsUrl rejects URLs exceeding the UTF-8 byte cap (non-ASCII path)", () => {
  // Without byte-aware checking (`Buffer.byteLength(value, "utf8")`),
  // a ~118-char URL whose non-ASCII path segments inflate to >255 bytes
  // would pass the route schema and only be rejected later by the
  // connector-level validator. That divergence is exactly the bug
  // this test guards against.
  const longChinese = "汉".repeat(110) // each char = 3 bytes → 330 bytes
  const url = `wss://example.com/${longChinese}`
  // Sanity: confirm the test fixture is in the problematic zone.
  assert.ok(url.length < 255, "string length under 255 (would pass .max(255))")
  assert.ok(
    Buffer.byteLength(url, "utf8") > 255,
    "byte length over 255 (must be rejected)"
  )
  const result = wecomAccountSchema.safeParse({
    ...validCreate,
    baseWsUrl: url,
  })
  assert.equal(result.success, false)
})

test("updateWecomAccountSchema baseWsUrl refinement also active", () => {
  const result = updateWecomAccountSchema.safeParse({
    baseWsUrl: "http://example.com",
  })
  assert.equal(result.success, false)
})

test("connectionMode literal rejects non-long_connection values", () => {
  const result = wecomAccountSchema.safeParse({
    ...validCreate,
    connectionMode: "webhook",
  })
  assert.equal(result.success, false)
})
