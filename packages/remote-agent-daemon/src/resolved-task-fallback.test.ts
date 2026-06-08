import assert from "node:assert/strict"
import test from "node:test"
import { buildResolvedPlanTaskFallbackPrompt } from "./resolved-task-fallback.js"

test("buildResolvedPlanTaskFallbackPrompt maps approved plan tasks to continue prompt", () => {
  const prompt = buildResolvedPlanTaskFallbackPrompt({
    kind: "plan_approval",
    outcome: "approved",
    resolutionNote: "ship it",
  })

  assert.ok(prompt)
  assert.match(prompt, /approved your plan/)
  assert.match(prompt, /ship it/)
})

test("buildResolvedPlanTaskFallbackPrompt maps revision_requested plan tasks to revise prompt", () => {
  const prompt = buildResolvedPlanTaskFallbackPrompt({
    kind: "plan_approval",
    outcome: "revision_requested",
    resolutionNote: "make the rollout safer",
  })

  assert.ok(prompt)
  assert.match(prompt, /revise your plan/)
  assert.match(prompt, /make the rollout safer/)
})

test("buildResolvedPlanTaskFallbackPrompt ignores stale rejected outcome", () => {
  assert.equal(
    buildResolvedPlanTaskFallbackPrompt({
      kind: "plan_approval",
      outcome: "rejected",
    }),
    null
  )
})

test("buildResolvedPlanTaskFallbackPrompt ignores non-plan tasks", () => {
  assert.equal(
    buildResolvedPlanTaskFallbackPrompt({
      kind: "user_input",
      outcome: "answered",
    }),
    null
  )
})
