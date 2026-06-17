import test from "node:test"
import assert from "node:assert/strict"
import {
  parseDingtalkProviderResponseText,
  readDingtalkProviderResponse,
} from "./response-codec.js"

test("parseDingtalkProviderResponseText accepts object provider responses", () => {
  assert.deepEqual(parseDingtalkProviderResponseText(""), {})
  assert.deepEqual(
    parseDingtalkProviderResponseText(
      JSON.stringify({
        errcode: 0,
        errmsg: "ok",
        accessToken: "token",
        expireIn: 7200,
      })
    ),
    {
      errcode: 0,
      errmsg: "ok",
      accessToken: "token",
      expireIn: 7200,
    }
  )
})

test("parseDingtalkProviderResponseText rejects malformed or non-object responses", () => {
  assert.equal(parseDingtalkProviderResponseText("{not-json"), null)
  assert.equal(parseDingtalkProviderResponseText("[]"), null)
  assert.equal(parseDingtalkProviderResponseText("null"), null)
  assert.equal(parseDingtalkProviderResponseText('"ok"'), null)
  assert.equal(parseDingtalkProviderResponseText("1"), null)
})

test("readDingtalkProviderResponse maps malformed provider bodies to explicit failure", async () => {
  for (const body of ["{not-json", "[]", "null", '"ok"', "1"]) {
    assert.deepEqual(await readDingtalkProviderResponse(new Response(body)), {
      code: "malformed_response",
      errmsg: "DingTalk provider response body is not a JSON object",
    })
  }
})
