import assert from "node:assert/strict"
import test from "node:test"

import { parseSelfEventSubscriptionMatcherInput } from "./session-tools.js"
import { ToolExecutionError } from "./tool-errors.js"

test("parseSelfEventSubscriptionMatcherInput accepts absent and object matcher input", () => {
  assert.equal(parseSelfEventSubscriptionMatcherInput(undefined), undefined)
  assert.equal(parseSelfEventSubscriptionMatcherInput("   "), undefined)
  assert.equal(
    parseSelfEventSubscriptionMatcherInput({ ignored: true }),
    undefined
  )

  assert.deepEqual(
    parseSelfEventSubscriptionMatcherInput(
      JSON.stringify({
        kind: "deployment",
        labels: ["prod"],
        nested: { severity: "high" },
      })
    ),
    {
      kind: "deployment",
      labels: ["prod"],
      nested: { severity: "high" },
    }
  )
})

test("parseSelfEventSubscriptionMatcherInput rejects invalid JSON", () => {
  assert.throws(
    () => parseSelfEventSubscriptionMatcherInput("{"),
    (error) =>
      error instanceof ToolExecutionError &&
      error.message === "matcher must be valid JSON"
  )
})

test("parseSelfEventSubscriptionMatcherInput rejects non-object JSON", () => {
  for (const value of ["[]", "null", '"text"', "42", "true"]) {
    assert.throws(
      () => parseSelfEventSubscriptionMatcherInput(value),
      (error) =>
        error instanceof ToolExecutionError &&
        error.message === "matcher must be a JSON object string",
      value
    )
  }
})
