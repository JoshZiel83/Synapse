import test from "node:test"
import assert from "node:assert/strict"
import {
  extractQqExternalMessageId,
  extractQqProviderBizCode,
  parseQqProviderFailureText,
  parseQqSendSuccessResponse,
  parseQqUploadSuccessResponse,
} from "./response-codec.js"

test("parseQqProviderFailureText: reads code/message aliases", () => {
  assert.deepEqual(
    parseQqProviderFailureText(
      JSON.stringify({ code: 304082, message: "retry later" })
    ),
    { code: 304082, message: "retry later" }
  )
  assert.deepEqual(
    parseQqProviderFailureText(
      JSON.stringify({ err_code: 40093002, msg: "quota exceeded" })
    ),
    { code: 40093002, message: "quota exceeded" }
  )
})

test("parseQqProviderFailureText: malformed or drifted payload falls back to raw text", () => {
  assert.deepEqual(parseQqProviderFailureText("{not-json"), {
    message: "{not-json",
  })
  assert.deepEqual(
    parseQqProviderFailureText(JSON.stringify({ code: "304082", message: 42 })),
    { message: '{"code":"304082","message":42}' }
  )
})

test("extractQqProviderBizCode: reads numeric code aliases only", () => {
  assert.equal(
    extractQqProviderBizCode(JSON.stringify({ code: 304083 })),
    304083
  )
  assert.equal(
    extractQqProviderBizCode(JSON.stringify({ err_code: 40093002 })),
    40093002
  )
  assert.equal(
    extractQqProviderBizCode(JSON.stringify({ code: "40093002" })),
    undefined
  )
  assert.equal(extractQqProviderBizCode("{not-json"), undefined)
})

test("parseQqSendSuccessResponse: validates success id aliases", () => {
  assert.deepEqual(parseQqSendSuccessResponse({ id: "ID-1" }), {
    id: "ID-1",
  })
  assert.equal(extractQqExternalMessageId({ message_id: "MSG-1" }), "MSG-1")
  assert.equal(extractQqExternalMessageId({ msg_id: "MSG-2" }), "MSG-2")
  assert.equal(parseQqSendSuccessResponse({ id: 123 }), null)
  assert.equal(extractQqExternalMessageId({ id: "" }), undefined)
})

test("parseQqUploadSuccessResponse: maps upload snake_case response to adapter record", () => {
  assert.deepEqual(
    parseQqUploadSuccessResponse({
      file_info: "FILE-INFO",
      file_uuid: "FILE-UUID",
      ignored: true,
    }),
    { fileInfo: "FILE-INFO", fileUuid: "FILE-UUID" }
  )
  assert.equal(parseQqUploadSuccessResponse({ file_uuid: "FILE-UUID" }), null)
  assert.equal(parseQqUploadSuccessResponse({ file_info: "" }), null)
})
