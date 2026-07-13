// cubesandbox:bare liveness-mapping unit tests (m4).
//
// probeLiveness feeds a control-plane getInfo result into mapCubeInfoToLiveness,
// whose R3.4-tristate contract these tests pin: every live/keep SandboxState →
// 'alive' (a paused/pausing box is RESUMABLE and must NOT be reaped); a 404/absent
// sandbox (null) → 'dead' (the only state irreversible reap is gated on); and an
// UNRECOGNIZED/terminal state → 'unknown' (a fail-safe shield, NEVER a silent
// default-to-'alive' that would keep a dead-but-queryable tombstone alive forever).

import test from "node:test"
import assert from "node:assert/strict"
import { mapCubeInfoToLiveness } from "../cubesandbox-adapter.js"
import type { SandboxInfo, SandboxState } from "./types.js"

function info(state: SandboxState): SandboxInfo {
  return {
    sandboxID: "sbx-1",
    templateID: "tpl-1",
    clientID: "client-1",
    state,
    envdVersion: "0.5.11",
  }
}

test("m4: every live/keep SandboxState maps to 'alive'", () => {
  for (const state of ["running", "paused", "pausing"] as const) {
    assert.equal(
      mapCubeInfoToLiveness(info(state)),
      "alive",
      `${state} is live/resumable → must NOT be reaped`
    )
  }
})

test("m4: a 404/absent sandbox (null) maps to 'dead'", () => {
  assert.equal(mapCubeInfoToLiveness(null), "dead")
})

test("m4: an UNRECOGNIZED/terminal state maps to 'unknown', never 'alive'", () => {
  // These are NOT in the current SandboxState union — a terminated-but-queryable
  // tombstone or a future state must fail-safe to 'unknown' (R3.4 shield), so it is
  // neither reaped (would need 'dead') nor shielded forever (would need 'alive').
  for (const state of [
    "stopped",
    "terminated",
    "error",
    "killed",
    "resuming",
  ]) {
    assert.equal(
      mapCubeInfoToLiveness(info(state as SandboxState)),
      "unknown",
      `${state} must fail-safe to 'unknown' (no silent default-to-alive)`
    )
  }
})
