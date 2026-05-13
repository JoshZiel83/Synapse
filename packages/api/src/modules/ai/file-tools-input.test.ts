import test from "node:test"
import assert from "node:assert/strict"
import { ToolExecutionError } from "./tool-errors.js"
import { normalizeActorUploadFileInput } from "./file-tools-input.js"

test("normalizeActorUploadFileInput accepts text payloads", () => {
  const parsed = normalizeActorUploadFileInput({
    filename: "note.txt",
    textContent: "hello",
  })

  assert.equal(parsed.filename, "note.txt")
  assert.equal(parsed.textContent, "hello")
})

test("normalizeActorUploadFileInput rejects unsupported fields", () => {
  assert.throws(
    () =>
      normalizeActorUploadFileInput({
        filename: "note.txt",
        textContent: "hello",
        category: "actor_output",
      }),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.message.includes("Unrecognized key")
  )
})
