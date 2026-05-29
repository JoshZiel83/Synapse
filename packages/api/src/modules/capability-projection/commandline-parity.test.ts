// Parity test for the commandline wire schema. The shared package keeps
// the canonical wire schema (WireCommandlinePolicySchema in
// @synapse/shared/access/policies/commandline.ts); the device-protocol
// package intentionally re-declares an equivalent schema (RuntimeCommandline
// PolicySchema in @synapse/device-protocol/src/schemas.ts) so device-
// protocol stays free of any @synapse/shared dependency.
//
// This test runs the same sample inputs through BOTH parsers and asserts
// they agree on success/failure. If either side drifts (someone adds a
// field to one and not the other), CI breaks here loudly.
//
// Lives in @synapse/api because api is the only package that already
// imports both @synapse/shared and @synapse/device-protocol — keeping the
// test here preserves the "device-protocol has no shared dep" invariant.

import { test } from "node:test"
import assert from "node:assert/strict"

import { WireCommandlinePolicySchema } from "@synapse/shared/access/policies"
import { RuntimeCommandlinePolicySchema } from "@synapse/device-protocol"

const SAMPLES: { name: string; value: unknown; valid: boolean }[] = [
  // ─── shell branch ───
  {
    name: "bash exact",
    value: {
      executor: "bash",
      command_match_type: "exact",
      command_text: "git status",
    },
    valid: true,
  },
  {
    name: "bash prefix with workdir + allow_bundled_toolchain",
    value: {
      executor: "bash",
      command_match_type: "prefix",
      command_text: "git",
      working_directory: "/repo",
      allow_bundled_toolchain: true,
      allowed_env: ["NODE_OPTIONS"],
    },
    valid: true,
  },
  {
    name: "powershell exact",
    value: {
      executor: "powershell",
      command_match_type: "exact",
      command_text: "Get-Process",
    },
    valid: true,
  },
  {
    name: "bash with invalid match type",
    value: {
      executor: "bash",
      command_match_type: "argv_exact", // exec_file match type used on shell branch
      command_text: "git status",
    },
    valid: false,
  },
  // ─── exec_file branch ───
  {
    name: "exec_file argv_exact",
    value: {
      executor: "exec_file",
      command_match_type: "argv_exact",
      program: "git",
      argv_prefix: ["status"],
    },
    valid: true,
  },
  {
    name: "exec_file argv_prefix with all optional fields",
    value: {
      executor: "exec_file",
      command_match_type: "argv_prefix",
      program: "git",
      argv_prefix: ["log"],
      working_directory: "/repo",
      allow_bundled_toolchain: true,
      allowed_env: [],
    },
    valid: true,
  },
  {
    name: "exec_file argv_exact_preapproved with no argvPrefix",
    value: {
      executor: "exec_file",
      command_match_type: "argv_exact_preapproved",
      program: "node",
    },
    valid: true,
  },
  {
    name: "exec_file with shell match type",
    value: {
      executor: "exec_file",
      command_match_type: "exact", // shell match type used on exec_file branch
      program: "git",
    },
    valid: false,
  },
  // ─── invalid root ───
  {
    name: "unknown executor",
    value: {
      executor: "fish",
      command_match_type: "exact",
    },
    valid: false,
  },
  {
    name: "missing executor",
    value: {
      command_match_type: "exact",
      command_text: "git",
    },
    valid: false,
  },
]

for (const sample of SAMPLES) {
  test(`schema parity: ${sample.name} (expect ${sample.valid ? "OK" : "FAIL"})`, () => {
    const sharedResult = WireCommandlinePolicySchema.safeParse(sample.value)
    const protocolResult = RuntimeCommandlinePolicySchema.safeParse(
      sample.value
    )
    assert.equal(
      sharedResult.success,
      protocolResult.success,
      `parity drift: shared=${sharedResult.success} protocol=${protocolResult.success}`
    )
    assert.equal(sharedResult.success, sample.valid)
    if (sharedResult.success && protocolResult.success) {
      assert.deepEqual(sharedResult.data, protocolResult.data)
    }
  })
}
