import test from "node:test"
import assert from "node:assert/strict"
import {
  normalizeQqC2cMessage,
  normalizeQqGroupAtMessage,
} from "./normalize.js"

test("C2C: basic text", async () => {
  const env = await normalizeQqC2cMessage({
    id: "MSG123",
    author: { user_openid: "USER1" },
    content: "hello world",
  })
  assert.ok(env)
  assert.equal(env?.endpointType, "direct")
  assert.equal(env?.endpointExternalId, "c2c:USER1")
  assert.equal(env?.externalMessageId, "MSG123")
  assert.equal(env?.sender.externalId, "c2c:USER1")
  assert.equal(env?.message.plainText, "hello world")
})

test("C2C: missing id or author → null", async () => {
  assert.equal(
    await normalizeQqC2cMessage({ id: "", author: { user_openid: "U" } }),
    null
  )
  assert.equal(await normalizeQqC2cMessage({ id: "M", author: {} }), null)
})

test("Group @bot: encodes gm:{group}:{member} and strips leading <@…>", async () => {
  const env = await normalizeQqGroupAtMessage({
    id: "MSG456",
    group_openid: "GRP1",
    author: { member_openid: "MEM1" },
    content: "<@BOTOPENID> hello group",
  })
  assert.ok(env)
  assert.equal(env?.endpointType, "group")
  assert.equal(env?.endpointExternalId, "GRP1")
  assert.equal(env?.sender.externalId, "gm:GRP1:MEM1")
  assert.equal(env?.message.plainText, "hello group")
})

test("Group @bot: missing group_openid or member_openid → null", async () => {
  assert.equal(
    await normalizeQqGroupAtMessage({
      id: "M",
      author: { member_openid: "MEM" },
    }),
    null
  )
  assert.equal(
    await normalizeQqGroupAtMessage({
      id: "M",
      group_openid: "GRP",
      author: {},
    }),
    null
  )
})

test("Empty body produces a message with empty parts (caller decides what to do)", async () => {
  const env = await normalizeQqC2cMessage({
    id: "M1",
    author: { user_openid: "U" },
    content: "   ",
  })
  assert.ok(env)
  assert.equal(env?.message.parts.length, 0)
  assert.equal(env?.message.plainText, "")
})

test("C2C: image attachment → text + image_placeholder part", async () => {
  const env = await normalizeQqC2cMessage({
    id: "M",
    author: { user_openid: "U" },
    content: "look",
    attachments: [
      {
        content_type: "image/png",
        filename: "p.png",
        url: "multimedia.nt.qq.com.cn/x",
        width: 10,
        height: 20,
      },
    ],
  })
  assert.ok(env)
  const parts = env!.message.parts
  assert.equal(parts.length, 2)
  assert.equal(parts[0]!.type, "text")
  assert.equal(parts[1]!.type, "system_marker")
  assert.equal((parts[1] as { marker?: string }).marker, "image_placeholder")
  assert.ok(env!.message.plainText.includes("[图片]"))
})

test("C2C: attachment without url is skipped (not downloadable)", async () => {
  const env = await normalizeQqC2cMessage({
    id: "M",
    author: { user_openid: "U" },
    content: "hi",
    attachments: [{ filename: "x.png" }],
  })
  assert.ok(env)
  assert.equal(env!.message.parts.length, 1)
  assert.equal(env!.message.parts[0]!.type, "text")
})

test("Group: voice attachment classified by content_type → voice_placeholder", async () => {
  const env = await normalizeQqGroupAtMessage({
    id: "M",
    group_openid: "G",
    author: { member_openid: "MEM" },
    content: "<@BOT> ",
    attachments: [
      { content_type: "audio/silk", url: "multimedia.nt.qq.com.cn/v" },
    ],
  })
  assert.ok(env)
  const parts = env!.message.parts
  // leading mention stripped → no text part; just the placeholder.
  assert.equal(parts.length, 1)
  assert.equal((parts[0] as { marker?: string }).marker, "voice_placeholder")
})

test("raw + endpointMetadata preserve QQ-specific fields", async () => {
  const env = await normalizeQqGroupAtMessage({
    id: "M",
    group_openid: "G",
    author: { member_openid: "MEM", union_openid: "UNION" },
    content: "<@BOT> hi",
    message_type: 103,
    attachments: [{ filename: "a.png" }],
  })
  assert.ok(env)
  assert.equal((env?.raw as { messageType?: number }).messageType, 103)
  assert.deepEqual(env?.endpointMetadata, { groupOpenid: "G" })
  assert.equal(
    (env?.sender.metadata as { unionOpenid?: string }).unionOpenid,
    "UNION"
  )
})
