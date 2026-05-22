import test from "node:test"
import assert from "node:assert/strict"
import { normalizeWeixinMessage } from "./normalize.js"

test("text message normalizes to a single text part", () => {
  const env = normalizeWeixinMessage({
    from_user_id: "wx_user_1",
    message_id: 100,
    item_list: [{ type: 1, msg_id: "m1", text_item: { text: "你好" } }],
  })
  assert.ok(env)
  assert.equal(env.endpointType, "direct")
  assert.equal(env.endpointExternalId, "wx_user_1")
  assert.equal(env.externalMessageId, "m1")
  assert.equal(env.message.parts.length, 1)
  if (env.message.parts[0].type === "text") {
    assert.equal(env.message.parts[0].text, "你好")
  }
})

test("voice with transcription emits voice_placeholder + label", () => {
  const env = normalizeWeixinMessage({
    from_user_id: "wx_user_1",
    message_id: 101,
    item_list: [{ type: 3, msg_id: "m2", voice_item: { text: "你好世界" } }],
  })
  assert.ok(env)
  if (env.message.parts[0].type === "system_marker") {
    assert.equal(env.message.parts[0].marker, "voice_placeholder")
    assert.equal(env.message.parts[0].label, "[语音] 你好世界")
  } else {
    assert.fail("expected system_marker")
  }
})

test("image item produces image_placeholder", () => {
  const env = normalizeWeixinMessage({
    from_user_id: "wx_user_1",
    message_id: 102,
    item_list: [{ type: 2, msg_id: "m3" }],
  })
  assert.ok(env)
  if (env.message.parts[0].type === "system_marker") {
    assert.equal(env.message.parts[0].marker, "image_placeholder")
  } else {
    assert.fail("expected system_marker")
  }
})

test("file / video items produce respective placeholders", () => {
  for (const [type, expected] of [
    [4, "file_placeholder"],
    [5, "video_placeholder"],
  ] as const) {
    const env = normalizeWeixinMessage({
      from_user_id: "wx_user_1",
      message_id: 200 + type,
      item_list: [{ type, msg_id: `m${type}` }],
    })
    assert.ok(env)
    if (env.message.parts[0].type === "system_marker") {
      assert.equal(env.message.parts[0].marker, expected)
    } else {
      assert.fail(`expected system_marker for type ${type}`)
    }
  }
})

test("contextToken is exposed for outbound use", () => {
  const env = normalizeWeixinMessage({
    from_user_id: "wx_user_1",
    message_id: 1,
    item_list: [{ type: 1, msg_id: "m", text_item: { text: "x" } }],
    context_token: "ctx_abc",
  })
  assert.ok(env)
  assert.equal(env.contextToken, "ctx_abc")
  assert.equal(env.raw.contextToken, "ctx_abc")
})

test("missing from_user_id returns null", () => {
  assert.equal(
    normalizeWeixinMessage({
      message_id: 1,
      item_list: [{ type: 1, msg_id: "m", text_item: { text: "x" } }],
    }),
    null
  )
})

test("empty item_list emits [微信消息] placeholder", () => {
  const env = normalizeWeixinMessage({
    from_user_id: "wx_x",
    message_id: 5,
    item_list: [],
  })
  // No msg_id from items, falls back to message_id stringified
  assert.equal(env?.externalMessageId, "5")
  assert.equal(env?.rawText, "[微信消息]")
})
