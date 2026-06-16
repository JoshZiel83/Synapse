import test from "node:test"
import assert from "node:assert/strict"
import {
  extractFeishuRawText,
  parseFeishuContentObject,
} from "./content-codec.js"

test("extractFeishuRawText: extracts text content from provider JSON", () => {
  assert.equal(extractFeishuRawText("text", '{"text":"hello"}'), "hello")
  assert.equal(extractFeishuRawText("text", '{"text":""}'), "")
  assert.equal(
    extractFeishuRawText("text", "plain text fallback"),
    "plain text fallback"
  )
})

test("extractFeishuRawText: preserves prior file and media fallbacks", () => {
  assert.equal(
    extractFeishuRawText("file", '{"file_name":"report.pdf","file_key":"fk"}'),
    "[文件 report.pdf]"
  )
  assert.equal(extractFeishuRawText("file", "{}"), "[文件]")
  assert.equal(extractFeishuRawText("image", '{"image_key":"img"}'), "[图片]")
  assert.equal(extractFeishuRawText("image", "not-json"), "not-json")
})

test("extractFeishuRawText: treats parsed non-object JSON as provider JSON", () => {
  assert.equal(extractFeishuRawText("text", "null"), "")
  assert.equal(extractFeishuRawText("text", "[]"), "")
  assert.equal(extractFeishuRawText("file", "null"), "[文件]")
  assert.equal(extractFeishuRawText("image", "null"), "[图片]")
})

test("parseFeishuContentObject: accepts only object provider content", () => {
  assert.deepEqual(parseFeishuContentObject('{"image_key":"img"}'), {
    image_key: "img",
  })
  assert.equal(parseFeishuContentObject("{not-json"), undefined)
  assert.equal(parseFeishuContentObject("[]"), undefined)
  assert.equal(parseFeishuContentObject("null"), undefined)
})
