import test from "node:test"
import assert from "node:assert/strict"
import { normalizeFeishuMessageEvent } from "./normalize.js"

test("normalizes a p2p text message", () => {
  const env = normalizeFeishuMessageEvent({
    sender: { sender_id: { open_id: "ou_a" } },
    message: {
      message_id: "om_1",
      chat_id: "oc_p2p_x",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "你好" }),
    },
  })
  assert.ok(env)
  assert.equal(env.endpointType, "direct")
  assert.equal(env.endpointExternalId, "oc_p2p_x")
  assert.equal(env.externalMessageId, "om_1")
  assert.equal(env.senderExternalId, "ou_a")
  assert.equal(env.message.parts.length, 1)
  if (env.message.parts[0].type === "text") {
    assert.equal(env.message.parts[0].text, "你好")
  }
})

test("group chat with mention produces text + mention parts", () => {
  const env = normalizeFeishuMessageEvent({
    sender: { sender_id: { open_id: "ou_a" } },
    message: {
      message_id: "om_2",
      chat_id: "oc_g",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "@_user_1 ping" }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_b" }, name: "Bob" }],
    },
  })
  assert.ok(env)
  assert.equal(env.endpointType, "group")
  // Text part has the substituted markup; mention part is appended
  const textPart = env.message.parts.find((p) => p.type === "text")
  assert.ok(textPart && textPart.type === "text")
  assert.ok(textPart.text.includes('<at user_id="ou_b">Bob</at>'))
  const mentionPart = env.message.parts.find((p) => p.type === "mention")
  assert.ok(mentionPart && mentionPart.type === "mention")
  if (mentionPart.type === "mention") {
    assert.equal(mentionPart.externalId, "ou_b")
  }
})

test("image message produces image_placeholder system_marker", () => {
  const env = normalizeFeishuMessageEvent({
    sender: { sender_id: { open_id: "ou_a" } },
    message: {
      message_id: "om_3",
      chat_id: "oc_g",
      chat_type: "group",
      message_type: "image",
      content: JSON.stringify({ image_key: "img_x" }),
    },
  })
  assert.ok(env)
  const marker = env.message.parts.find((p) => p.type === "system_marker")
  assert.ok(marker && marker.type === "system_marker")
  if (marker.type === "system_marker") {
    assert.equal(marker.marker, "image_placeholder")
    assert.deepEqual(marker.original, { image_key: "img_x" })
  }
})

test("audio / media / video / file have correct markers", () => {
  for (const [type, expected] of [
    ["audio", "voice_placeholder"],
    // "media" is Feishu's real inbound video type; "video" is a kept alias.
    ["media", "video_placeholder"],
    ["video", "video_placeholder"],
    ["file", "file_placeholder"],
  ] as const) {
    const env = normalizeFeishuMessageEvent({
      sender: { sender_id: { open_id: "ou_a" } },
      message: {
        message_id: `om_${type}`,
        chat_id: "oc_x",
        chat_type: "group",
        message_type: type,
        content: "{}",
      },
    })
    assert.ok(env)
    const marker = env.message.parts.find((p) => p.type === "system_marker")
    if (marker?.type === "system_marker") {
      assert.equal(marker.marker, expected)
    } else {
      assert.fail(`expected system_marker for ${type}`)
    }
  }
})

test("returns null when sender id missing", () => {
  const env = normalizeFeishuMessageEvent({
    sender: { sender_id: {} },
    message: {
      message_id: "om_x",
      chat_id: "oc_x",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "x" }),
    },
  })
  assert.equal(env, null)
})

test("returns null when message id or chat id missing", () => {
  assert.equal(
    normalizeFeishuMessageEvent({
      sender: { sender_id: { open_id: "ou_a" } },
      message: {
        message_id: "",
        chat_id: "oc_x",
        message_type: "text",
        content: "{}",
      },
    }),
    null
  )
})

test("captures parent_id and thread_id for reply/thread support", () => {
  const env = normalizeFeishuMessageEvent({
    sender: { sender_id: { open_id: "ou_a" } },
    message: {
      message_id: "om_x",
      chat_id: "oc_g",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "reply" }),
      parent_id: "om_parent",
      thread_id: "omt_thread",
    },
  })
  assert.ok(env)
  assert.equal(env.externalReplyToId, "om_parent")
  assert.equal(env.externalThreadId, "omt_thread")
})

test("file message preserves file_name in extracted text", () => {
  const env = normalizeFeishuMessageEvent({
    sender: { sender_id: { open_id: "ou_a" } },
    message: {
      message_id: "om_x",
      chat_id: "oc_g",
      chat_type: "group",
      message_type: "file",
      content: JSON.stringify({ file_name: "report.pdf", file_key: "fk_x" }),
    },
  })
  assert.ok(env)
  assert.equal(env.rawText, "[文件 report.pdf]")
})
