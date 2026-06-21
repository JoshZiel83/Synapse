/**
 * Phase 2 (R1) gate: the tool-result-data contract.
 *
 * Asserts buildToolMeta gathers each family's structured result into the single
 * `toolMeta` namespace WITHOUT clobbering reserved top-level keys (origin /
 * structuredContent / isError / synapse_error / toolCallId / ...), and that
 * structuredContent wins over _meta on key collision.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { buildToolMeta } from "./tool-meta.js"

test("buildToolMeta: device/MCP _meta becomes toolMeta", () => {
  const out = buildToolMeta({
    meta: { edits_applied: 2, bytes_written: 320, sha256: "abc" },
  })
  assert.deepEqual(out, { edits_applied: 2, bytes_written: 320, sha256: "abc" })
})

test("buildToolMeta: MCP structuredContent merged, wins on collision", () => {
  const out = buildToolMeta({
    meta: { count: 1, fromMeta: true },
    structuredContent: { count: 99, fromStructured: true },
  })
  assert.equal(out?.count, 99) // structuredContent wins
  assert.equal(out?.fromMeta, true)
  assert.equal(out?.fromStructured, true)
})

test("buildToolMeta: reserved top-level keys are NOT pulled into toolMeta", () => {
  const out = buildToolMeta({
    meta: {
      origin: { kind: "system" },
      synapse_error: { code: "x" },
      isError: true,
      toolCallId: "id",
      real_field: 7,
    },
  })
  // only the non-reserved field survives
  assert.deepEqual(out, { real_field: 7 })
})

test("buildToolMeta: nothing structured → undefined (caller omits the key)", () => {
  assert.equal(buildToolMeta({}), undefined)
  assert.equal(buildToolMeta({ meta: {} }), undefined)
  assert.equal(buildToolMeta({ meta: { origin: { kind: "x" } } }), undefined)
  assert.equal(buildToolMeta({ meta: "not-an-object" }), undefined)
})

test("buildToolMeta: synapse_error stays top-level only (R1 must not break it)", () => {
  // Simulate a device error result whose _meta carries synapse_error: it must
  // NOT leak into toolMeta (top-level consumers own it), and toolMeta should be
  // undefined when that's the only key.
  const out = buildToolMeta({ meta: { synapse_error: { code: "E" } } })
  assert.equal(out, undefined)
})
