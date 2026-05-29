/**
 * Isolated test: "kind in TRANSPORT_KINDS but not registered" path.
 *
 * Lives in a separate file from `capability-assertions.test.ts` so we
 * can exercise the unregistered branch without polluting the live
 * registry. `register-all.js` is an ESM side-effect import — once a
 * sibling test pulls it in, the connectors stay registered for the
 * rest of the process. Calling `_resetConnectorRegistry()` from
 * inside the same file would clear them mid-flight but the modules
 * wouldn't re-evaluate, leaving subsequent assertions running
 * against an empty registry.
 *
 * Strategy: this file deliberately does NOT import
 * `./register-all.js`, and uses `_resetConnectorRegistry()` before
 * each assertion to make sure no other previously-loaded module's
 * side effect leaks in. We then call the assertion helpers with a
 * real `TRANSPORT_KINDS` value (`"feishu"`) — the realistic shape of
 * the "enum has it but nobody registered it" failure mode.
 */

import test from "node:test"
import assert from "node:assert/strict"

import { _resetConnectorRegistry } from "./registry.js"
import {
  assertSupportedConnectionMode,
  assertSupportedEndpointType,
} from "./index.js"

test("assertSupportedConnectionMode: unregistered kind → 400 transport_kind_unsupported", () => {
  _resetConnectorRegistry()
  try {
    assertSupportedConnectionMode("feishu", "webhook")
    assert.fail("expected throw")
  } catch (err) {
    const e = err as Error & { statusCode?: unknown; code?: unknown }
    assert.equal(e.statusCode, 400)
    assert.equal(e.code, "transport_kind_unsupported")
    assert.match(e.message, /feishu/)
  }
})

test("assertSupportedEndpointType: unregistered kind → 400 transport_kind_unsupported", () => {
  _resetConnectorRegistry()
  try {
    assertSupportedEndpointType("feishu", "direct")
    assert.fail("expected throw")
  } catch (err) {
    const e = err as Error & { statusCode?: unknown; code?: unknown }
    assert.equal(e.statusCode, 400)
    assert.equal(e.code, "transport_kind_unsupported")
    assert.match(e.message, /feishu/)
  }
})
