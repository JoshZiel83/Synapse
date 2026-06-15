import assert from "node:assert/strict"
import test from "node:test"
import { normalizeActorDocInputs, readDecodedArray } from "./doc-codec.js"

test("readDecodedArray only accepts already-decoded arrays", () => {
  assert.deepEqual(readDecodedArray(["one"]), ["one"])
  assert.deepEqual(readDecodedArray('["legacy"]'), [])
  assert.deepEqual(readDecodedArray({ value: ["not-array"] }), [])
})

test("normalizeActorDocInputs normalizes and sorts decoded actor docs", () => {
  const docs = normalizeActorDocInputs([
    {
      id: "00000000-0000-4000-8000-000000000001",
      key: "custom",
      title: "Low",
      content: [{ type: "text", text: "Low priority" }],
      visibility: "always",
      priority: 1,
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      key: "custom",
      title: "High",
      content: [{ type: "text", text: "High priority" }],
      visibility: "always",
      priority: 10,
    },
  ])

  assert.deepEqual(
    docs.map((doc) => doc.title),
    ["High", "Low"]
  )
})
