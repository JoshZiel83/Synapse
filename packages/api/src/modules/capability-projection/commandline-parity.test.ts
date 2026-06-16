// Regression test for commandline wire-schema ownership.
//
// The snake_case commandline policy is a wire contract: it belongs to
// @synapse/device-protocol. @synapse/shared may expose a compatibility alias so
// API callers keep using the existing import path, but it must not redeclare a
// second schema copy that can drift from the signed-envelope contract.

import { test } from "node:test"
import assert from "node:assert/strict"

import { RuntimeCommandlinePolicySchema } from "@synapse/device-protocol"
import { WireCommandlinePolicySchema } from "@synapse/shared/access/policies"

test("shared commandline wire schema is the device-protocol-owned schema", () => {
  assert.equal(WireCommandlinePolicySchema, RuntimeCommandlinePolicySchema)
})
