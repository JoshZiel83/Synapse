import test from "node:test"
import assert from "node:assert/strict"
import {
  extractFeishuRawText,
  flattenFeishuPost,
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
  // Inbound video arrives as message_type "media" — must not leak raw JSON.
  assert.equal(extractFeishuRawText("media", '{"file_key":"fk"}'), "[视频]")
})

test("extractFeishuRawText: treats parsed non-object JSON as provider JSON", () => {
  assert.equal(extractFeishuRawText("text", "null"), "")
  assert.equal(extractFeishuRawText("text", "[]"), "")
  assert.equal(extractFeishuRawText("file", "null"), "[文件]")
  assert.equal(extractFeishuRawText("image", "null"), "[图片]")
})

test("extractFeishuRawText: flattens post rich text instead of dumping raw JSON", () => {
  const post = JSON.stringify({
    title: "项目更新",
    content: [
      [
        { tag: "text", text: "第一行 " },
        { tag: "a", text: "链接", href: "https://x.test" },
      ],
      [
        { tag: "at", user_id: "ou_a", user_name: "Alice" },
        { tag: "text", text: " 看一下" },
      ],
    ],
  })
  const out = extractFeishuRawText("post", post)
  assert.equal(out, "项目更新\n第一行 链接 (https://x.test)\n@Alice 看一下")
  // It must NOT be the raw JSON blob.
  assert.ok(!out.includes('"tag"'))
})

test("flattenFeishuPost: unwraps a single locale layer and handles @all/img", () => {
  const out = flattenFeishuPost({
    zh_cn: {
      title: "",
      content: [
        [
          { tag: "at", user_id: "all" },
          { tag: "img", image_key: "k" },
        ],
      ],
    },
  })
  assert.equal(out, "@all[图片]")
})

test("extractFeishuRawText: malformed post falls back to placeholder", () => {
  // Valid JSON object but not a real post structure → empty body → placeholder.
  assert.equal(extractFeishuRawText("post", "{}"), "[富文本消息]")
  // Non-object JSON → placeholder, never raw text.
  assert.equal(extractFeishuRawText("post", "null"), "[富文本消息]")
})

test("parseFeishuContentObject: accepts only object provider content", () => {
  assert.deepEqual(parseFeishuContentObject('{"image_key":"img"}'), {
    image_key: "img",
  })
  assert.equal(parseFeishuContentObject("{not-json"), undefined)
  assert.equal(parseFeishuContentObject("[]"), undefined)
  assert.equal(parseFeishuContentObject("null"), undefined)
})
