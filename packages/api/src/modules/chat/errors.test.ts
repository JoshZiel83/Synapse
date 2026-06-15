import test from "node:test"
import assert from "node:assert/strict"
import { createChatError, isChatServiceError } from "./errors.js"

test("createChatError builds the controller-facing error shape", () => {
  const error = createChatError(403, "workspace_access_denied", "Denied", {
    reason: "membership",
  })

  assert.equal(error.message, "Denied")
  assert.equal(error.statusCode, 403)
  assert.equal(error.code, "workspace_access_denied")
  assert.deepEqual(error.details, { reason: "membership" })
  assert.equal(isChatServiceError(error), true)
})

test("isChatServiceError rejects ordinary errors", () => {
  assert.equal(isChatServiceError(new Error("plain")), false)
  assert.equal(isChatServiceError({ statusCode: 400 }), false)
  assert.equal(isChatServiceError({ code: "invalid" }), false)
})
