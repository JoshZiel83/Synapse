import assert from "node:assert/strict"
import test from "node:test"
import { FILE_ORIGIN_SYSTEMS } from "@synapse/shared/constants"
import { parseFileUploadOriginField } from "./upload-origin-codec.js"

test("parseFileUploadOriginField: accepts user-upload multipart origin JSON", () => {
  const result = parseFileUploadOriginField(
    JSON.stringify({
      family: "user_upload",
      system: FILE_ORIGIN_SYSTEMS.WORKSPACE_WEB_UPLOAD,
      details: { source: "composer" },
    })
  )

  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.origin.system, FILE_ORIGIN_SYSTEMS.WORKSPACE_WEB_UPLOAD)
    assert.deepEqual(result.origin.details, { source: "composer" })
  }
})

test("parseFileUploadOriginField: rejects invalid JSON before schema parsing", () => {
  const result = parseFileUploadOriginField("{not-json")

  assert.deepEqual(result, { ok: false, error: "origin must be valid JSON" })
})

test("parseFileUploadOriginField: rejects non-user-upload origins", () => {
  const result = parseFileUploadOriginField(
    JSON.stringify({
      family: "tool_output",
      system: FILE_ORIGIN_SYSTEMS.ACTOR_TOOL_UPLOAD_FILE,
    })
  )

  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.error, /^Invalid origin:/)
  }
})
