/**
 * Contract tests for the connector capability layer.
 *
 * Covers:
 *  - `assertSupportedConnectionMode` / `assertSupportedEndpointType`
 *    return clean 4xx-mapped errors (statusCode + stable `code`),
 *    NOT plain `Error` that the Fastify error handler would turn
 *    into a 500. This is the regression the WeCom branch caught:
 *    POST /im/accounts with `{transportKind: "wecom",
 *    connectionMode: "webhook"}` used to surface as 500 instead of
 *    a 400 with `transport_connection_mode_unsupported`.
 *
 *  - Registration coverage: every entry in `TRANSPORT_KINDS` has a
 *    connector registered via the single `register-all` entrypoint.
 *    Guards against the "added enum, forgot to add import" failure
 *    mode where the metadata API silently omits a connector.
 *
 *  - Capability field completeness: each connector's
 *    `TransportConnectorCapability` and `MessageCapabilities` set
 *    every field. Prevents accidentally landing a new
 *    `MessageCapabilities.supportsFoo` field while letting old
 *    connectors fall back to `undefined`.
 *
 * For the "kind missing from registry entirely" path, see the
 * sibling `capability-assertions-unregistered.test.ts` file —
 * keeping it isolated means we don't pollute the registry by
 * `_resetConnectorRegistry()` here.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { TRANSPORT_KINDS } from "@synapse/shared/constants"
import type { TransportKind } from "@synapse/shared/types"

// Single registration entrypoint — same import production goes through.
import "./register-all.js"

import {
  assertSupportedConnectionMode,
  assertSupportedEndpointType,
  listTransportConnectorCapabilities,
} from "./index.js"
import { listConnectors } from "./registry.js"

test("assertSupportedConnectionMode: passes for a supported (kind, mode) pair", () => {
  // Feishu supports both webhook and long_connection — pick that as a
  // stable example that should always be permitted.
  assert.doesNotThrow(() =>
    assertSupportedConnectionMode("feishu", "long_connection")
  )
  assert.doesNotThrow(() => assertSupportedConnectionMode("feishu", "webhook"))
})

test("assertSupportedConnectionMode: rejected pair → 400 + stable code", () => {
  // WeCom v1 lists no supported connection modes (placeholder on
  // dev), so any mode is an unsupported pair.
  try {
    assertSupportedConnectionMode("wecom", "webhook")
    assert.fail("expected throw")
  } catch (err) {
    const e = err as Error & { statusCode?: unknown; code?: unknown }
    assert.equal(e.statusCode, 400, "must be 400, not 500")
    assert.equal(e.code, "transport_connection_mode_unsupported")
    assert.match(e.message, /wecom/)
    assert.match(e.message, /webhook/)
  }
})

test("assertSupportedEndpointType: rejected pair → 400 + stable code", () => {
  try {
    // Cast to bypass the literal-union check; production callers go
    // through the runtime path with arbitrary string values from DB
    // rows / ingestion.
    assertSupportedEndpointType(
      "wecom",
      "not-a-real-endpoint-type" as unknown as "direct"
    )
    assert.fail("expected throw")
  } catch (err) {
    const e = err as Error & { statusCode?: unknown; code?: unknown }
    assert.equal(e.statusCode, 400)
    assert.equal(e.code, "transport_endpoint_type_unsupported")
  }
})

test("registry covers every TRANSPORT_KINDS entry", () => {
  const registered = listTransportConnectorCapabilities()
    .map((c) => c.transportKind)
    .slice()
    .sort()
  const expected = [...TRANSPORT_KINDS].slice().sort()
  assert.deepEqual(
    registered,
    expected,
    `expected register-all.ts to cover exactly ${JSON.stringify(
      expected
    )}, got ${JSON.stringify(registered)}. ` +
      `If you added a kind to TRANSPORT_KINDS, also add its side-effect import to register-all.ts.`
  )
})

test("every registered connector populates capability + messageCapabilities fully", () => {
  const requiredCapabilityKeys: Array<keyof TransportConnectorCapabilityShape> =
    [
      "transportKind",
      "supportedConnectionModes",
      "supportedEndpointTypes",
      "supportsDirectMessages",
      "supportsGroupMessages",
      "displayName",
      "iconAssetPath",
      // showsBaseUrlConfig is optional — only weixin sets it true; others
      // legitimately leave it undefined.
    ]
  const requiredMessageCapabilityKeys: Array<keyof MessageCapabilitiesShape> = [
    "canEdit",
    "canReact",
    "canTyping",
    "canSendCard",
    "canStream",
    "supportsGroup",
    "supportsMention",
    "supportsReply",
    "supportsImage",
    "supportsFile",
    "supportsVoice",
    "supportsVideo",
    "supportsInteractionPrompt",
    "maxTextBytes",
    "directMentionPolicy",
  ]
  for (const connector of listConnectors()) {
    for (const key of requiredCapabilityKeys) {
      assert.notEqual(
        (connector.capability as unknown as Record<string, unknown>)[key],
        undefined,
        `${connector.transportKind} capability missing ${String(key)}`
      )
    }
    for (const key of requiredMessageCapabilityKeys) {
      assert.notEqual(
        (connector.messageCapabilities as unknown as Record<string, unknown>)[
          key
        ],
        undefined,
        `${connector.transportKind} messageCapabilities missing ${String(key)}`
      )
    }
  }
  // Touch TransportKind import so an unused-import lint can't trim it.
  const sentinel: TransportKind = TRANSPORT_KINDS[0]
  void sentinel
})

// Local shape helpers — duplicates of the public interfaces, kept
// here so the test can iterate field names without depending on
// internal type machinery.
interface TransportConnectorCapabilityShape {
  transportKind: unknown
  supportedConnectionModes: unknown
  supportedEndpointTypes: unknown
  supportsDirectMessages: unknown
  supportsGroupMessages: unknown
  displayName: unknown
  iconAssetPath: unknown
  showsBaseUrlConfig?: unknown
}
interface MessageCapabilitiesShape {
  canEdit: unknown
  canReact: unknown
  canTyping: unknown
  canSendCard: unknown
  canStream: unknown
  supportsGroup: unknown
  supportsMention: unknown
  supportsReply: unknown
  supportsImage: unknown
  supportsFile: unknown
  supportsVoice: unknown
  supportsVideo: unknown
  supportsInteractionPrompt: unknown
  maxTextBytes: unknown
  directMentionPolicy: unknown
}
