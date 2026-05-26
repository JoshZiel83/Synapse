// Regression test for Issue LLL: when capability-projection creates a
// runtime_authorization interaction for a remote_agent principal, it
// deliberately skips createToolCallTask (the bridged agent retries its
// own tool call instead of being woken via chat session machinery). The
// resolution flow must short-circuit instead of throwing "missing task
// governance" after the grant has already been created in-transaction.

import test from "node:test"
import assert from "node:assert/strict"

import { runtimeAuthorizationApprovalSkipsTaskCompletion } from "./service.js"
import { INTERACTION_REQUEST_KIND } from "@synapse/shared"

test("runtime_authorization + no taskId skips task completion (remote_agent path)", () => {
  assert.equal(
    runtimeAuthorizationApprovalSkipsTaskCompletion({
      kind: INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION,
      taskId: undefined,
    }),
    true,
    "remote_agent runtime authorization must skip the task-completion branch"
  )
  assert.equal(
    runtimeAuthorizationApprovalSkipsTaskCompletion({
      kind: INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION,
      taskId: null,
    }),
    true,
    "null taskId behaves the same as undefined — the grant is still valid"
  )
})

test("runtime_authorization WITH taskId does NOT skip task completion (actor path)", () => {
  assert.equal(
    runtimeAuthorizationApprovalSkipsTaskCompletion({
      kind: INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION,
      taskId: "task-actor-driven",
    }),
    false,
    "actor / actor_in_conversation principals still drive task completion"
  )
})

test("non-runtime-authorization interactions never use the skip branch", () => {
  for (const kind of [
    INTERACTION_REQUEST_KIND.USER_INPUT,
    INTERACTION_REQUEST_KIND.PLAN_APPROVAL,
  ]) {
    assert.equal(
      runtimeAuthorizationApprovalSkipsTaskCompletion({
        kind,
        taskId: undefined,
      }),
      false,
      `${kind} without taskId should fall through to the generic guard`
    )
  }
})
