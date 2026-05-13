import test from "node:test"
import assert from "node:assert/strict"
import {
  assertPlanModeConversationKind,
  canEnterPlanMode,
  canExitPlanMode,
  canUpdatePlan,
  isBuiltinToolAllowedInCollaborationMode,
} from "./session-plan-mode.js"

test("plan mode is available only in private conversations", () => {
  assert.equal(canEnterPlanMode("default", "private"), true)
  assert.equal(canEnterPlanMode("default", "group"), false)
  assert.throws(
    () => assertPlanModeConversationKind("group"),
    /Plan mode is only available in private conversations/i
  )
})

test("drafting state enables update and exit plan tools", () => {
  assert.equal(canUpdatePlan("plan_drafting", "private"), true)
  assert.equal(canExitPlanMode("plan_drafting", "private"), true)
  assert.equal(canUpdatePlan("plan_awaiting_approval", "private"), false)
  assert.equal(canExitPlanMode("plan_awaiting_approval", "private"), false)
})

test("tool allowance changes across drafting and awaiting-approval states", () => {
  assert.equal(
    isBuiltinToolAllowedInCollaborationMode(
      "request_user_input",
      "plan_drafting",
      "private"
    ),
    true
  )
  assert.equal(
    isBuiltinToolAllowedInCollaborationMode(
      "request_user_input",
      "plan_awaiting_approval",
      "private"
    ),
    false
  )
  assert.equal(
    isBuiltinToolAllowedInCollaborationMode(
      "enter_plan_mode",
      "default",
      "group"
    ),
    false
  )
  assert.equal(
    isBuiltinToolAllowedInCollaborationMode(
      "tail_task_output",
      "plan_awaiting_approval",
      "private"
    ),
    true
  )
})
