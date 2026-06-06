import test from "node:test"
import assert from "node:assert/strict"
import {
  assertPlanModeConversationKind,
  canEnterPlanMode,
  canExitPlanMode,
  canUpdatePlan,
  isLocalCallableToolAllowedInCollaborationMode,
} from "./session-plan-mode.js"

test("plan mode is available only in direct conversations", () => {
  assert.equal(canEnterPlanMode("default", "direct"), true)
  assert.equal(canEnterPlanMode("default", "group"), false)
  assert.throws(
    () => assertPlanModeConversationKind("group"),
    /Plan mode is only available in direct conversations/i
  )
})

test("drafting state enables update and exit plan tools", () => {
  assert.equal(canUpdatePlan("plan_drafting", "direct"), true)
  assert.equal(canExitPlanMode("plan_drafting", "direct"), true)
  assert.equal(canUpdatePlan("plan_awaiting_approval", "direct"), false)
  assert.equal(canExitPlanMode("plan_awaiting_approval", "direct"), false)
})

test("tool allowance changes across drafting and awaiting-approval states", () => {
  assert.equal(
    isLocalCallableToolAllowedInCollaborationMode(
      "request_user_input",
      "plan_drafting",
      "direct"
    ),
    true
  )
  assert.equal(
    isLocalCallableToolAllowedInCollaborationMode(
      "request_user_input",
      "plan_awaiting_approval",
      "direct"
    ),
    false
  )
  assert.equal(
    isLocalCallableToolAllowedInCollaborationMode(
      "enter_plan_mode",
      "default",
      "group"
    ),
    false
  )
  assert.equal(
    isLocalCallableToolAllowedInCollaborationMode(
      "tail_task_output",
      "plan_awaiting_approval",
      "direct"
    ),
    true
  )
})
