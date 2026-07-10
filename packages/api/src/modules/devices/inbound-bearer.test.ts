// Unit test for the per-runtime inbound bearer derivation (§3.4 / §3.3).

import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { deriveRuntimeInboundBearer } from "./inbound-bearer.js"

test("bearer is deterministic for a given runtime id (recomputable, never stored)", () => {
  const id = randomUUID()
  const a = deriveRuntimeInboundBearer(id)
  const b = deriveRuntimeInboundBearer(id)
  assert.equal(
    a,
    b,
    "same runtime id → same bearer across calls (survives restart)"
  )
})

test("bearer is a 64-char sha256 hex digest", () => {
  const v = deriveRuntimeInboundBearer(randomUUID())
  assert.match(v, /^[0-9a-f]{64}$/)
})

test("distinct runtime ids yield distinct bearers", () => {
  const a = deriveRuntimeInboundBearer(randomUUID())
  const b = deriveRuntimeInboundBearer(randomUUID())
  assert.notEqual(a, b)
})
