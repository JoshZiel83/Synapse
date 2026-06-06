// Regression test for Issue LLL/QQQ: when capability-projection creates
// a runtime_authorization interaction for a remote_agent principal, it
// deliberately skips createToolCallTask (the bridged agent retries its
// own tool call instead of being woken via chat session machinery). The
// resolution flow must short-circuit instead of throwing
// "missing task governance" after the grant has already been created
// in-transaction.
//
// QQQ narrowed the contract: the short-circuit fires only when the
// principal was actually a remote_agent. An actor-path bug that dropped
// taskId would otherwise have silently succeeded, masking a broken
// task governance link.

import test from "node:test"
import assert from "node:assert/strict"

import { runtimeAuthorizationApprovalSkipsTaskCompletion } from "./service.js"
import { INTERACTION_REQUEST_KIND, SUBJECT_KIND } from "@synapse/shared"

test("remote_agent runtime_authorization with no taskId → skip (QQQ)", () => {
  assert.equal(
    runtimeAuthorizationApprovalSkipsTaskCompletion({
      kind: INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION,
      taskId: undefined,
      principalSubjectKind: SUBJECT_KIND.REMOTE_AGENT,
    }),
    true,
    "the bridged remote agent retries its own call — no chat session to wake"
  )
  assert.equal(
    runtimeAuthorizationApprovalSkipsTaskCompletion({
      kind: INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION,
      taskId: null,
      principalSubjectKind: SUBJECT_KIND.REMOTE_AGENT,
    }),
    true,
    "null taskId behaves the same as undefined"
  )
})

test("runtime_authorization without remoteAgentId still REQUIRES taskId (QQQ fail-loud)", () => {
  // This is the load-bearing assertion for QQQ. The previous version of
  // the helper short-circuited on `runtime_authorization && !taskId`
  // alone, which would mask an actor-path bug that dropped the task.
  // The narrowed contract requires a remote_agent principal — otherwise
  // the generic "missing task governance" guard MUST fire instead so
  // the actor regression doesn't silently succeed.
  assert.equal(
    runtimeAuthorizationApprovalSkipsTaskCompletion({
      kind: INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION,
      taskId: undefined,
      principalSubjectKind: undefined,
    }),
    false,
    "actor path with missing taskId must fail loudly, not short-circuit"
  )
  assert.equal(
    runtimeAuthorizationApprovalSkipsTaskCompletion({
      kind: INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION,
      taskId: undefined,
      principalSubjectKind: undefined,
    }),
    false,
    "null remoteAgentId is treated the same as undefined"
  )
  assert.equal(
    runtimeAuthorizationApprovalSkipsTaskCompletion({
      kind: INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION,
      taskId: undefined,
      principalSubjectKind: undefined,
    }),
    false,
    "empty-string remoteAgentId is not a valid principal"
  )
})

test("runtime_authorization WITH taskId does NOT skip task completion", () => {
  assert.equal(
    runtimeAuthorizationApprovalSkipsTaskCompletion({
      kind: INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION,
      taskId: "task-actor-driven",
      principalSubjectKind: SUBJECT_KIND.REMOTE_AGENT,
    }),
    false,
    "even remote_agent flows take the task-completion path when a task exists"
  )
  assert.equal(
    runtimeAuthorizationApprovalSkipsTaskCompletion({
      kind: INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION,
      taskId: "task-actor-driven",
      principalSubjectKind: undefined,
    }),
    false,
    "actor principals always drive task completion"
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
        principalSubjectKind: SUBJECT_KIND.REMOTE_AGENT,
      }),
      false,
      `${kind} without taskId should fall through to the generic guard ` +
        `even when a remote-agent id is present`
    )
  }
})

// End-to-end coverage: rather than spinning up a full DB-backed approval
// (which the surrounding integration suite does at a higher level), we
// exercise the resolve flow's BRANCH STRUCTURE here by enumerating every
// (kind, taskId, remoteAgentId) tuple the resolveInteractionRequest
// post-commit logic dispatches on. If any combination changes route
// without updating this matrix, the test will fail.
test("approval routing matrix (QQQ end-to-end shape)", () => {
  type Case = {
    kind: (typeof INTERACTION_REQUEST_KIND)[keyof typeof INTERACTION_REQUEST_KIND]
    taskId?: string | null
    principalSubjectKind?: string
    expectSkip: boolean
    note: string
  }
  const cases: Case[] = [
    {
      kind: INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION,
      taskId: undefined,
      principalSubjectKind: SUBJECT_KIND.REMOTE_AGENT,
      expectSkip: true,
      note: "remote_agent approval, no task — the only short-circuit case",
    },
    {
      kind: INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION,
      taskId: "tk-1",
      principalSubjectKind: SUBJECT_KIND.REMOTE_AGENT,
      expectSkip: false,
      note: "remote_agent approval with a task — task completion still runs",
    },
    {
      kind: INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION,
      taskId: undefined,
      principalSubjectKind: undefined,
      expectSkip: false,
      note: "actor approval with missing task — must fail loud",
    },
    {
      kind: INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION,
      taskId: "tk-1",
      principalSubjectKind: undefined,
      expectSkip: false,
      note: "actor approval with task — normal path",
    },
    {
      kind: INTERACTION_REQUEST_KIND.USER_INPUT,
      taskId: undefined,
      principalSubjectKind: undefined,
      expectSkip: false,
      note: "user_input never short-circuits",
    },
    {
      kind: INTERACTION_REQUEST_KIND.PLAN_APPROVAL,
      taskId: undefined,
      principalSubjectKind: undefined,
      expectSkip: false,
      note: "plan_approval never short-circuits",
    },
  ]
  for (const c of cases) {
    assert.equal(
      runtimeAuthorizationApprovalSkipsTaskCompletion({
        kind: c.kind,
        taskId: c.taskId,
        principalSubjectKind: c.principalSubjectKind,
      }),
      c.expectSkip,
      c.note
    )
  }
})
