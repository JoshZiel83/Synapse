/**
 * Tests for the pure portions of service/accounts.ts:
 *
 *   - `mergeAccountCredentials` — covers the Feishu partial-credential
 *     PUT regression (sending {encryptKey} would wipe appId/appSecret).
 *   - `validateAndNormalizeAccountCredentials` — covers the contract
 *     that the connector's normalized form is what gets persisted, and
 *     the disabled-status escape hatch.
 *
 * We register a minimal stub connector below instead of pulling in
 * `connectors/<kind>/index.ts`. The real connector modules transitively
 * import Redis (cursor-store, qr-session-store), which would leave open
 * connection pools after the test process completes and stall the test
 * runner. The stub is enough to exercise validateAndNormalize's contract
 * with the registry without dragging in IO.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { registerConnector, tryGetConnector } from "../connectors/registry.js"
import type {
  ConnectorLogger,
  TransportConnector,
} from "../connectors/types.js"
import type { MessageCapabilities } from "../messaging/degradation.js"
import {
  mergeAccountCredentials,
  validateAndNormalizeAccountConfig,
  validateAndNormalizeAccountCredentials,
} from "./account-credentials.js"

const STUB_CAPS: MessageCapabilities = {
  canEdit: false,
  canReact: false,
  canTyping: false,
  canSendCard: false,
  canStream: false,
  supportsGroup: false,
  supportsMention: false,
  supportsReply: false,
  supportsImage: false,
  supportsFile: false,
  maxTextBytes: 1_000,
  directMentionPolicy: "attached_only",
}

const STUB_KIND = "weixin" as const // a real TransportKind enum value the
// registry will accept; the stub
// overrides whatever else might have
// been registered for the duration of
// this process.

// Stub that mimics the validator behavior we want to exercise: require a
// "token" field, return a `normalized` form that trims it and adds a derived
// field. This lets us prove that the service layer (a) actually consults
// the connector, (b) persists the normalized form rather than the raw
// input, and (c) preserves the disabled-status escape hatch.
const stubConnector: TransportConnector = {
  transportKind: STUB_KIND,
  capability: {
    transportKind: STUB_KIND,
    supportedConnectionModes: ["long_connection"],
    supportedEndpointTypes: ["direct"],
    supportsDirectMessages: true,
    supportsGroupMessages: false,
  },
  messageCapabilities: STUB_CAPS,
  validateCredentials(input) {
    const token = input.credentials?.token
    if (typeof token !== "string" || !token.trim()) {
      return { ok: false, errors: ["token is required"] }
    }
    return {
      ok: true,
      normalized: { token: token.trim(), source: "normalized-by-stub" },
    }
  },
  async startAccount() {
    throw new Error("stub")
  },
  async sendMessage() {
    throw new Error("stub")
  },
  createStatusReactionAdapter: () => null,
  createTypingAdapter: () => null,
  parseInboundMentions: () => ({ text: "", mentions: [] }),
  renderOutboundMention: () => "",
}

// Only register if no real connector took the slot before this test file
// loaded. Tests must not depend on test-file load order.
if (!tryGetConnector(STUB_KIND)) {
  registerConnector(stubConnector)
}

test("mergeAccountCredentials: undefined incoming returns existing unchanged", () => {
  const existing = { appId: "cli_x", appSecret: "old" }
  const out = mergeAccountCredentials(existing, undefined)
  assert.deepEqual(out, existing)
})

test("mergeAccountCredentials: partial incoming preserves untouched fields", () => {
  // Real-world scenario: Feishu account exists with appId+appSecret, and
  // the user does PUT /im/accounts/feishu/:id with just {encryptKey}.
  // Pre-fix this would have stored {encryptKey} and lost the other two,
  // causing validation to fail on the next read.
  const out = mergeAccountCredentials(
    { appId: "cli_x", appSecret: "secret_x" },
    { encryptKey: "enc_x" }
  )
  assert.deepEqual(out, {
    appId: "cli_x",
    appSecret: "secret_x",
    encryptKey: "enc_x",
  })
})

test("mergeAccountCredentials: incoming field overrides existing", () => {
  const out = mergeAccountCredentials(
    { appId: "cli_x", appSecret: "old" },
    { appSecret: "rotated" }
  )
  assert.deepEqual(out, { appId: "cli_x", appSecret: "rotated" })
})

test("mergeAccountCredentials: empty existing + full incoming acts as create", () => {
  const out = mergeAccountCredentials(
    {},
    { appId: "cli_x", appSecret: "s", encryptKey: "k" }
  )
  assert.deepEqual(out, { appId: "cli_x", appSecret: "s", encryptKey: "k" })
})

test("validateAndNormalizeAccountCredentials: disabled status skips validation", () => {
  // Even nonsense credentials are accepted when status=disabled. Lets
  // operators stash a half-configured account until the rest of the
  // credentials are available.
  const out = validateAndNormalizeAccountCredentials({
    transportKind: STUB_KIND,
    connectionMode: "long_connection",
    status: "disabled",
    credentials: { not: "valid" },
  })
  assert.deepEqual(out, { not: "valid" })
})

test("validateAndNormalizeAccountCredentials: invalid input throws connector errors", () => {
  assert.throws(
    () =>
      validateAndNormalizeAccountCredentials({
        transportKind: STUB_KIND,
        connectionMode: "long_connection",
        status: "active",
        credentials: {},
      }),
    /token is required/
  )
})

test("validateAndNormalizeAccountCredentials: returns connector normalized form", () => {
  // The stub strips whitespace and adds a derived field; we should see
  // both behaviors in the returned value — proving the service layer is
  // actually persisting normalized credentials, not the raw input.
  const out = validateAndNormalizeAccountCredentials({
    transportKind: STUB_KIND,
    connectionMode: "long_connection",
    status: "active",
    credentials: { token: "  raw-padded-token  " },
  })
  assert.equal(out.token, "raw-padded-token")
  assert.equal(out.source, "normalized-by-stub")
})

test("validateAndNormalizeAccountCredentials: unknown transport_kind throws", () => {
  assert.throws(
    () =>
      validateAndNormalizeAccountCredentials({
        transportKind: "not-a-real-kind" as any,
        connectionMode: "long_connection",
        status: "active",
        credentials: {},
      }),
    /no connector registered/i
  )
})

// ─── validateAndNormalizeAccountConfig ───
//
// Covers the dispatch hook that closes the bypass on the generic
// `/im/accounts` route — without this, a POST with `transportKind: "wecom"`
// + `config: {baseWsUrl: "http://..."}` would persist unvalidated despite
// the per-route wecom schema rejecting `http://`.

test("validateAndNormalizeAccountConfig: connector without validateConfig is no-op", () => {
  // STUB_KIND's stub doesn't implement validateConfig. The helper must
  // treat absent validator as "any config is fine" so existing
  // connectors (feishu/weixin) keep working unchanged.
  const out = validateAndNormalizeAccountConfig({
    transportKind: STUB_KIND,
    connectionMode: "long_connection",
    status: "active",
    config: { anyKey: "anyValue" },
  })
  assert.deepEqual(out, { anyKey: "anyValue" })
})

test("validateAndNormalizeAccountConfig: undefined config defaults to {}", () => {
  const out = validateAndNormalizeAccountConfig({
    transportKind: STUB_KIND,
    connectionMode: "long_connection",
    status: "active",
    config: undefined,
  })
  assert.deepEqual(out, {})
})

test("validateAndNormalizeAccountConfig: connector validateConfig rejection throws", () => {
  // Register a one-off stub for an unused kind that REJECTS any config
  // with a `bad: true` field, mirroring how wecom rejects non-ws(s)://
  // baseWsUrl. The throw is what surfaces to the API layer as a 4xx.
  const TEST_KIND = "feishu" as const
  const existing = tryGetConnector(TEST_KIND)
  // Save and replace
  const guardedStub: TransportConnector = {
    transportKind: TEST_KIND,
    capability: {
      transportKind: TEST_KIND,
      supportedConnectionModes: ["long_connection"],
      supportedEndpointTypes: ["direct"],
      supportsDirectMessages: true,
      supportsGroupMessages: false,
    },
    messageCapabilities: STUB_CAPS,
    validateCredentials: () => ({ ok: true, normalized: {} }),
    validateConfig: (input) => {
      if (input.config.bad === true) {
        return {
          ok: false,
          errors: ["test-stub rejects {bad:true}"],
        }
      }
      return { ok: true, normalized: input.config }
    },
    async startAccount() {
      throw new Error("stub")
    },
    async sendMessage() {
      throw new Error("stub")
    },
    createStatusReactionAdapter: () => null,
    createTypingAdapter: () => null,
    parseInboundMentions: () => ({ text: "", mentions: [] }),
    renderOutboundMention: () => "",
  }
  registerConnector(guardedStub)
  try {
    assert.throws(
      () =>
        validateAndNormalizeAccountConfig({
          transportKind: TEST_KIND,
          connectionMode: "long_connection",
          status: "active",
          config: { bad: true },
        }),
      /rejects \{bad:true\}/
    )
    // Sanity: the same stub accepts the valid case.
    const out = validateAndNormalizeAccountConfig({
      transportKind: TEST_KIND,
      connectionMode: "long_connection",
      status: "active",
      config: { ok: true },
    })
    assert.deepEqual(out, { ok: true })
  } finally {
    if (existing) registerConnector(existing)
  }
})

test("validateAndNormalizeAccountConfig: disabled status skips validation", () => {
  // Mirrors the credentials helper's disabled-status escape hatch:
  // operators can stash a half-configured account without tripping
  // validation. Use the rejecting stub above to prove the skip.
  const TEST_KIND = "feishu" as const
  const existing = tryGetConnector(TEST_KIND)
  registerConnector({
    transportKind: TEST_KIND,
    capability: {
      transportKind: TEST_KIND,
      supportedConnectionModes: ["long_connection"],
      supportedEndpointTypes: ["direct"],
      supportsDirectMessages: true,
      supportsGroupMessages: false,
    },
    messageCapabilities: STUB_CAPS,
    validateCredentials: () => ({ ok: true, normalized: {} }),
    validateConfig: () => ({ ok: false, errors: ["always rejects"] }),
    async startAccount() {
      throw new Error("stub")
    },
    async sendMessage() {
      throw new Error("stub")
    },
    createStatusReactionAdapter: () => null,
    createTypingAdapter: () => null,
    parseInboundMentions: () => ({ text: "", mentions: [] }),
    renderOutboundMention: () => "",
  } satisfies TransportConnector)
  try {
    const out = validateAndNormalizeAccountConfig({
      transportKind: TEST_KIND,
      connectionMode: "long_connection",
      status: "disabled",
      config: { anything: true },
    })
    assert.deepEqual(out, { anything: true })
  } finally {
    if (existing) registerConnector(existing)
  }
})

test("validateAndNormalizeAccountConfig: returns connector normalized form", () => {
  const TEST_KIND = "feishu" as const
  const existing = tryGetConnector(TEST_KIND)
  registerConnector({
    transportKind: TEST_KIND,
    capability: {
      transportKind: TEST_KIND,
      supportedConnectionModes: ["long_connection"],
      supportedEndpointTypes: ["direct"],
      supportsDirectMessages: true,
      supportsGroupMessages: false,
    },
    messageCapabilities: STUB_CAPS,
    validateCredentials: () => ({ ok: true, normalized: {} }),
    validateConfig: (input) => ({
      ok: true,
      // Drop unknown keys, return only the supported field.
      normalized:
        typeof input.config.url === "string"
          ? { url: input.config.url.trim() }
          : {},
    }),
    async startAccount() {
      throw new Error("stub")
    },
    async sendMessage() {
      throw new Error("stub")
    },
    createStatusReactionAdapter: () => null,
    createTypingAdapter: () => null,
    parseInboundMentions: () => ({ text: "", mentions: [] }),
    renderOutboundMention: () => "",
  } satisfies TransportConnector)
  try {
    const out = validateAndNormalizeAccountConfig({
      transportKind: TEST_KIND,
      connectionMode: "long_connection",
      status: "active",
      config: { url: "  wss://example  ", extra: "dropped" },
    })
    assert.deepEqual(out, { url: "wss://example" })
  } finally {
    if (existing) registerConnector(existing)
  }
})
