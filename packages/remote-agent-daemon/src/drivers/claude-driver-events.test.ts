import test from "node:test"
import assert from "node:assert/strict"
import {
  __extractAssistantTextForTest,
  __buildPermissionResultForDecisionForTest,
} from "./claude-driver.js"

const extractAssistantText = __extractAssistantTextForTest as (msg: {
  message?: any
}) => string
const buildPermissionResultForDecision =
  __buildPermissionResultForDecisionForTest as (
    decision:
      | { behavior: "allow"; updatedInput?: Record<string, unknown> }
      | { behavior: "deny"; message: string },
    toolUseID: string
  ) => any

test("extractAssistantText concatenates only text content blocks", () => {
  assert.equal(
    extractAssistantText({
      message: {
        content: [
          { type: "text", text: "hello " },
          { type: "tool_use", id: "x", name: "Read", input: {} },
          { type: "text", text: "world" },
        ],
      },
    }),
    "hello world"
  )
})

test("extractAssistantText returns empty string when content is missing or empty", () => {
  assert.equal(extractAssistantText({}), "")
  assert.equal(extractAssistantText({ message: {} }), "")
  assert.equal(extractAssistantText({ message: { content: [] } }), "")
})

test("buildPermissionResultForDecision encodes an allow decision with updatedInput", () => {
  const result = buildPermissionResultForDecision(
    { behavior: "allow", updatedInput: { answers: { a: "1" } } },
    "tool-use-42"
  )
  assert.deepEqual(result, {
    behavior: "allow",
    updatedInput: { answers: { a: "1" } },
    toolUseID: "tool-use-42",
  })
})

test("buildPermissionResultForDecision defaults updatedInput to empty when omitted", () => {
  const result = buildPermissionResultForDecision(
    { behavior: "allow" } as any,
    "tool-use-1"
  )
  assert.deepEqual(result.updatedInput, {})
})

test("buildPermissionResultForDecision propagates deny with the supplied user-visible message", () => {
  const result = buildPermissionResultForDecision(
    { behavior: "deny", message: "user asked to revise" },
    "tool-use-99"
  )
  assert.deepEqual(result, {
    behavior: "deny",
    message: "user asked to revise",
    toolUseID: "tool-use-99",
  })
})
