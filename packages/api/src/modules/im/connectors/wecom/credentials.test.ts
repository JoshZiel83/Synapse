import test from "node:test"
import assert from "node:assert/strict"
import {
  extractWecomConfig,
  extractWecomCredentials,
  validateWecomConfig,
  validateWecomCredentialsForMode,
} from "./credentials.js"

test("accepts canonical botId/secret", () => {
  const r = extractWecomCredentials({ botId: "bot_x", secret: "s" })
  assert.equal(r.errors.length, 0)
  assert.equal(r.credentials?.botId, "bot_x")
  assert.equal(r.credentials?.secret, "s")
})

test("reports missing required fields", () => {
  const r = extractWecomCredentials({})
  assert.ok(r.errors.includes("botId is required"))
  assert.ok(r.errors.includes("secret is required"))
})

test("whitespace-only treated as missing", () => {
  const r = extractWecomCredentials({ botId: "   ", secret: "  " })
  assert.equal(r.errors.length, 2)
})

test("extractWecomConfig picks up canonical baseWsUrl", () => {
  assert.deepEqual(extractWecomConfig({ baseWsUrl: "wss://x" }), {
    baseWsUrl: "wss://x",
  })
  assert.deepEqual(extractWecomConfig({}), {})
  assert.deepEqual(extractWecomConfig(null), {})
  assert.deepEqual(extractWecomConfig(undefined), {})
})

test("extractWecomConfig and credentials are independent", () => {
  // The validateCredentials contract only sees credentials — config must
  // never be smuggled inside the credentials JSON.
  const r = extractWecomCredentials({
    botId: "x",
    secret: "y",
    baseWsUrl: "wss://should-not-appear-here",
  })
  assert.equal(r.credentials?.botId, "x")
  assert.equal(
    (r.credentials as unknown as { baseWsUrl?: string }).baseWsUrl,
    undefined
  )
})

test("validateWecomCredentialsForMode rejects non long_connection", () => {
  const r = validateWecomCredentialsForMode(
    { botId: "x", secret: "y" },
    "webhook"
  )
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /long_connection/)
})

test("validateWecomCredentialsForMode ok for long_connection", () => {
  const r = validateWecomCredentialsForMode(
    { botId: "x", secret: "y" },
    "long_connection"
  )
  assert.equal(r.ok, true)
  assert.equal(r.normalized?.botId, "x")
  assert.equal(r.normalized?.secret, "y")
})

test("validateWecomCredentialsForMode propagates missing-field errors", () => {
  const r = validateWecomCredentialsForMode({}, "long_connection")
  assert.equal(r.ok, false)
  assert.ok(r.errors.includes("botId is required"))
  assert.ok(r.errors.includes("secret is required"))
})

// ─── validateWecomConfig ───
//
// Used by service/account-credentials.ts:validateAndNormalizeAccountConfig
// to close the generic-route bypass: without this, POSTing to
// `/im/accounts` with `transportKind:"wecom"` + `config:{baseWsUrl:"http://..."}`
// would persist unvalidated.

test("validateWecomConfig: empty/missing config is OK (no constraints)", () => {
  assert.deepEqual(validateWecomConfig({}), {
    ok: true,
    errors: [],
    normalized: {},
  })
  assert.deepEqual(validateWecomConfig(null), {
    ok: true,
    errors: [],
    normalized: {},
  })
  assert.deepEqual(validateWecomConfig(undefined), {
    ok: true,
    errors: [],
    normalized: {},
  })
})

test("validateWecomConfig accepts wss:// baseWsUrl", () => {
  const r = validateWecomConfig({
    baseWsUrl: "wss://openws.work.weixin.qq.com",
  })
  assert.equal(r.ok, true)
  assert.equal(r.normalized?.baseWsUrl, "wss://openws.work.weixin.qq.com")
})

test("validateWecomConfig accepts ws:// (dev gateway escape hatch)", () => {
  const r = validateWecomConfig({ baseWsUrl: "ws://localhost:9000" })
  assert.equal(r.ok, true)
})

test("validateWecomConfig rejects http:// baseWsUrl", () => {
  const r = validateWecomConfig({ baseWsUrl: "http://evil.example" })
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /wss:\/\//)
})

test("validateWecomConfig rejects https:// baseWsUrl", () => {
  const r = validateWecomConfig({ baseWsUrl: "https://evil.example" })
  assert.equal(r.ok, false)
})

test("validateWecomConfig rejects ftp:// baseWsUrl", () => {
  const r = validateWecomConfig({ baseWsUrl: "ftp://evil.example" })
  assert.equal(r.ok, false)
})

test("validateWecomConfig rejects wss:// with no host (malformed URL)", () => {
  // Bare regex `^wss?://` would have accepted this; URL parser catches it.
  const r = validateWecomConfig({ baseWsUrl: "wss://" })
  assert.equal(r.ok, false)
  // Error message mentions either "not a valid URL" or "missing a host"
  // depending on which guard fires first in the Node URL implementation.
  assert.match(r.errors[0], /valid URL|missing a host/)
})

test("validateWecomConfig rejects wss://host with embedded whitespace", () => {
  // `new URL("wss://bad host")` throws — bare regex would have accepted.
  const r = validateWecomConfig({ baseWsUrl: "wss://bad host" })
  assert.equal(r.ok, false)
})

test("validateWecomConfig rejects garbage string with wss-like prefix", () => {
  const r = validateWecomConfig({ baseWsUrl: "wss://this is not a url" })
  assert.equal(r.ok, false)
})

test("validateWecomConfig rejects baseWsUrl exceeding length cap", () => {
  // `WECOM_BASE_WS_URL_MAX_BYTES` is the hard cap (currently 255). A
  // pathological multi-kB input must be rejected before it reaches the
  // URL parser to keep validation cost bounded.
  const huge = `wss://${"a".repeat(3000)}`
  const r = validateWecomConfig({ baseWsUrl: huge })
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /exceeds|too long/i)
})

// ─── Type-mismatch on baseWsUrl (silent-drop regression guard) ───
//
// Without these checks, `firstNonEmpty` silently dropped non-string
// values, so `validateWecomConfig({baseWsUrl: 123})` returned
// `ok: true, normalized: {}` — meaning the caller's bad value was
// quietly thrown away and `POST /im/accounts` returned 201 with empty
// config. Surface as 400 (`transport_config_invalid` from the service
// wrapper) so the caller knows the field was rejected.

test("validateWecomConfig rejects baseWsUrl with non-string value", () => {
  const r = validateWecomConfig({ baseWsUrl: 123 } as unknown as Record<
    string,
    unknown
  >)
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /must be a string/)
  assert.match(r.errors[0], /number/)
})

test("validateWecomConfig rejects baseWsUrl with boolean / object / array", () => {
  for (const value of [
    true,
    false,
    {},
    [],
    { nested: "wss://x" },
  ] as unknown[]) {
    const r = validateWecomConfig({ baseWsUrl: value } as Record<
      string,
      unknown
    >)
    assert.equal(r.ok, false, `${JSON.stringify(value)} should be rejected`)
  }
})

test("validateWecomConfig rejects empty-string baseWsUrl", () => {
  const r = validateWecomConfig({ baseWsUrl: "" })
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /non-empty/)
})

test("validateWecomConfig rejects whitespace-only baseWsUrl", () => {
  const r = validateWecomConfig({ baseWsUrl: "   " })
  assert.equal(r.ok, false)
})

test("validateWecomConfig type-mismatch check applies to baseWsUrl", () => {
  const r = validateWecomConfig({ baseWsUrl: 42 } as Record<string, unknown>)
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /baseWsUrl/)
})

test("validateWecomConfig treats null/undefined baseWsUrl as absent (clearing semantics)", () => {
  // The wecom update controller maps `baseWsUrl: null` to a clearing
  // intent; the validator must NOT trip on null/undefined values.
  // Otherwise PUT bodies with `{baseWsUrl: null}` would 400 instead of
  // clearing the previously-saved URL.
  const a = validateWecomConfig({ baseWsUrl: null } as Record<string, unknown>)
  assert.equal(a.ok, true)
  assert.deepEqual(a.normalized, {})
  const b = validateWecomConfig({ baseWsUrl: undefined } as Record<
    string,
    unknown
  >)
  assert.equal(b.ok, true)
  assert.deepEqual(b.normalized, {})
})
