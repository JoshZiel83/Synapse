// R3.P2e-pty — a pty grant is UNROUTABLE end-to-end (normalizeGrantSpecForInsert
// drops its payload → corrupt read-back; toRuntimeAuthorizationGrantWireSpec
// throws). Owner decision (interim, no DDL): keep pty reserved/inert but FAIL
// LOUD at grant creation. The reject fires after GrantPolicySchema.parse but
// BEFORE any normalization/persistence, so this is a pure unit test with no
// withTestDb seam (no executor is threaded).

import test from "node:test"
import assert from "node:assert/strict"
import { workspaceRef } from "@synapse/shared"
import {
  createRuntimeAuthorizationGrant,
  PtyCapabilityNotSupportedError,
} from "./service.js"

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001"
const RUNTIME_ID = "00000000-0000-4000-8000-000000000002"
const RUNTIME_CAPABILITY_ID = "00000000-0000-4000-8000-000000000003"
const RUNTIME_EXPOSURE_ID = "00000000-0000-4000-8000-000000000004"

test("createRuntimeAuthorizationGrant rejects a pty capability loudly (pty_not_supported)", async () => {
  await assert.rejects(
    () =>
      createRuntimeAuthorizationGrant({
        workspaceId: WORKSPACE_ID,
        runtimeId: RUNTIME_ID,
        runtimeCapabilityId: RUNTIME_CAPABILITY_ID,
        runtimeExposureId: RUNTIME_EXPOSURE_ID,
        subject: workspaceRef(WORKSPACE_ID),
        retention: "until_revoked",
        // A well-formed pty policy that PARSES through GrantPolicySchema — the
        // reject must fire on the capability, not on a schema mismatch.
        policy: {
          capability: "pty",
          pty: { workingDirectory: "/workspace" },
        } as never,
      }),
    (err: unknown) => {
      assert.ok(
        err instanceof PtyCapabilityNotSupportedError,
        "throws PtyCapabilityNotSupportedError"
      )
      assert.equal(err.code, "pty_not_supported")
      assert.equal(err.message, "pty capability is not yet routable end-to-end")
      return true
    }
  )
})
