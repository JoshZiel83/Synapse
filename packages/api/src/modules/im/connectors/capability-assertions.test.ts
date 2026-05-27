/**
 * Tests for the capability assertion helpers in connectors/index.ts.
 *
 * Covers the contract that an unsupported connection mode / endpoint
 * type at the API boundary surfaces as a 400 (`statusCode` + stable
 * `code`), not a plain Error that the Fastify error handler falls
 * through to 500.
 *
 * Specifically defends against the bug where POSTing to the generic
 * `/im/accounts` route with `transportKind:"wecom"` +
 * `connectionMode:"webhook"` (which WeCom doesn't support) returned
 * "Internal Server Error" instead of a clean 400 with
 * `transport_connection_mode_unsupported`. The per-transport WeCom
 * route uses `z.literal("long_connection")` so it rejects at the schema
 * layer — only the generic route reaches `assertSupportedConnectionMode`.
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  assertSupportedConnectionMode,
  assertSupportedEndpointType,
} from "./index.js"
// Side-effect: ensure capability descriptors are registered. Without
// these imports the tests would run before any connector self-registers
// in the registry. We import only the credential-/capability-side
// modules (no Redis / SDK side effects) by going through the connector
// entry points — those side-effect-register the capability.
import "./feishu/index.js"
import "./weixin/index.js"
import "./wecom/index.js"

test("assertSupportedConnectionMode: passes for a supported pair", () => {
  // WeCom v1: long_connection only.
  assert.doesNotThrow(() =>
    assertSupportedConnectionMode("wecom", "long_connection")
  )
  // Feishu supports both webhook and long_connection.
  assert.doesNotThrow(() =>
    assertSupportedConnectionMode("feishu", "long_connection")
  )
  assert.doesNotThrow(() => assertSupportedConnectionMode("feishu", "webhook"))
})

test("assertSupportedConnectionMode: WeCom + webhook → 400 with stable code", () => {
  // The bug-class assertion. Pre-fix this throw was a plain Error,
  // mapping to 500 "Internal Server Error" via the global handler.
  try {
    assertSupportedConnectionMode("wecom", "webhook")
    assert.fail("expected throw")
  } catch (err) {
    assert.ok(err instanceof Error)
    const e = err as Error & { statusCode?: unknown; code?: unknown }
    assert.equal(e.statusCode, 400, "must be 400, not 500")
    assert.equal(e.code, "transport_connection_mode_unsupported")
    assert.match(e.message, /wecom/)
    assert.match(e.message, /webhook/)
  }
})

test("assertSupportedConnectionMode: error shape is stable for ALL kind mismatches", () => {
  // Future-proofs the contract: every mismatch should carry the same
  // shape so the Fastify error handler maps consistently.
  const mismatches: Array<[string, string]> = [["wecom", "webhook"]]
  // Defensive: only assert known mismatches; we deliberately don't
  // enumerate the full matrix because per-connector caps change.
  for (const [kind, mode] of mismatches) {
    try {
      assertSupportedConnectionMode(kind as "wecom", mode as "webhook")
      assert.fail(`${kind}+${mode} should throw`)
    } catch (err) {
      const e = err as Error & { statusCode?: unknown; code?: unknown }
      assert.equal(e.statusCode, 400)
      assert.equal(e.code, "transport_connection_mode_unsupported")
    }
  }
})

test("assertSupportedEndpointType: error shape mirrors connection-mode helper", () => {
  // Same fix applied; verify consistency.
  try {
    // WeCom supports both direct + group, so to trigger we have to
    // pass an invalid value. Cast through `any` to bypass the enum
    // narrowing — production callers go through the same path via
    // the runtime when ingestion produces an unexpected endpoint.
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
