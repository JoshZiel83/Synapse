import test from "node:test"
import assert from "node:assert/strict"
import {
  actorRef,
  conversationRef,
  remoteAgentRef,
  subjectScopeLabel,
  workspaceRef,
} from "@synapse/shared"

/**
 * Round 9 review (P2) regression test for the remote_agent label collapse.
 * The bug: `subjectScopeLabel` returned "remote_agent" for a remote_agent
 * subject, but the RuntimeBindingScope union didn't include it; skills +
 * mcp-plugins service-layer dedup paths defaulted to "workspace".
 *
 * NOTE (workspace-resource-authz-unification): the former DB-backed cases in
 * this file exercised the deleted `resource_access_bindings` table /
 * `binding-storage` helpers (automation authz folded into
 * `workspace_resource_grants`). Their characterization coverage now lives on the
 * unified grant path; only the pure label unit test remains here.
 */

test("subjectScopeLabel emits subject kind independent of scope", () => {
  assert.equal(
    subjectScopeLabel({ subject: remoteAgentRef("ra-1") }),
    "remote_agent"
  )
  assert.equal(
    subjectScopeLabel({
      subject: remoteAgentRef("ra-1"),
      scope: conversationRef("c-1"),
    }),
    "remote_agent"
  )
  // Existing labels still emit their canonical form.
  assert.equal(subjectScopeLabel({ subject: actorRef("a-1") }), "actor")
  assert.equal(
    subjectScopeLabel({
      subject: actorRef("a-1"),
      scope: conversationRef("c-1"),
    }),
    "actor"
  )
  assert.equal(subjectScopeLabel({ subject: workspaceRef("w-1") }), "workspace")
})
