import test from "node:test"
import assert from "node:assert/strict"
import {
  buildSessionPlanDraftState,
  parseSessionCollaborationState,
  requireSessionPlanDraftState,
} from "./collaboration-state.js"

test("parseSessionCollaborationState only accepts planDraft payloads", () => {
  assert.throws(
    () =>
      parseSessionCollaborationState({
        pendingPlanApprovalInteractionId: "interaction-1",
      }),
    /collaborationState\.pendingPlanApprovalInteractionId is not allowed/i
  )
})

test("parseSessionCollaborationState validates planDraft checklist entries", () => {
  assert.throws(
    () =>
      parseSessionCollaborationState({
        planDraft: {
          checklist: [{ step: "", status: "pending" }],
        },
      }),
    /collaborationState\.planDraft\.checklist\[0\]\.step is required/i
  )
})

test("requireSessionPlanDraftState throws when plan mode session is missing a draft", () => {
  assert.throws(
    () =>
      requireSessionPlanDraftState({
        collaborationMode: "plan_drafting",
        collaborationState: {},
      }),
    /missing collaborationState\.planDraft/i
  )
})

test("buildSessionPlanDraftState normalizes optional fields", () => {
  const draft = buildSessionPlanDraftState({
    summary: "  summary  ",
    explanation: "  explanation  ",
    enteredAt: "  2026-04-04T00:00:00.000Z  ",
    checklist: [{ step: "Ship it", status: "pending" }],
  })

  assert.deepEqual(draft, {
    summary: "summary",
    explanation: "explanation",
    enteredAt: "2026-04-04T00:00:00.000Z",
    checklist: [{ step: "Ship it", status: "pending" }],
  })
})
