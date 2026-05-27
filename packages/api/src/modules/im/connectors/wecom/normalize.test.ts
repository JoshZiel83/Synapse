import test from "node:test"
import assert from "node:assert/strict"
import type { WsFrame } from "@wecom/aibot-node-sdk"
import { normalizeWecomFrame } from "./normalize.js"

function buildFrame(body: Record<string, unknown>, reqId = "req-1"): WsFrame {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { headers: { req_id: reqId }, body } as any
}

test("text message in single chat → direct endpoint, senderExternalId is userid", () => {
  const env = normalizeWecomFrame(
    buildFrame({
      msgid: "m1",
      chattype: "single",
      from: { userid: "u-1" },
      msgtype: "text",
      text: { content: "hello" },
    })
  )
  assert.ok(env)
  assert.equal(env!.endpointType, "direct")
  assert.equal(env!.endpointExternalId, "u-1")
  assert.equal(env!.externalMessageId, "m1")
  assert.equal(env!.sender.externalId, "u-1")
  // SDK BaseMessage.from has no username/name field — displayName must be undefined
  assert.equal(env!.sender.displayName, undefined)
  assert.equal(env!.message.parts.length, 1)
  assert.deepEqual(env!.message.parts[0], { type: "text", text: "hello" })
  assert.equal(env!.message.plainText, "hello")
})

test("text message in group chat → group endpoint = chatid", () => {
  const env = normalizeWecomFrame(
    buildFrame({
      msgid: "m2",
      chattype: "group",
      chatid: "g-42",
      from: { userid: "u-7" },
      msgtype: "text",
      text: { content: "yo" },
    })
  )
  assert.ok(env)
  assert.equal(env!.endpointType, "group")
  assert.equal(env!.endpointExternalId, "g-42")
  assert.equal(env!.sender.externalId, "u-7")
})

test("group message without chatid is rejected", () => {
  const env = normalizeWecomFrame(
    buildFrame({
      msgid: "m3",
      chattype: "group",
      from: { userid: "u-1" },
      msgtype: "text",
      text: { content: "x" },
    })
  )
  assert.equal(env, null)
})

test("missing msgid → null", () => {
  const env = normalizeWecomFrame(
    buildFrame({
      chattype: "single",
      from: { userid: "u-1" },
      msgtype: "text",
      text: { content: "x" },
    })
  )
  assert.equal(env, null)
})

test("missing sender userid → null", () => {
  const env = normalizeWecomFrame(
    buildFrame({
      msgid: "m",
      chattype: "single",
      from: {},
      msgtype: "text",
      text: { content: "x" },
    })
  )
  assert.equal(env, null)
})

test("image message degrades to [图片]", () => {
  const env = normalizeWecomFrame(
    buildFrame({
      msgid: "m-img",
      chattype: "single",
      from: { userid: "u" },
      msgtype: "image",
      image: { url: "https://x" },
    })
  )
  assert.equal(env!.message.plainText, "[图片]")
})

test("file message degrades to [文件]", () => {
  const env = normalizeWecomFrame(
    buildFrame({
      msgid: "m-file",
      chattype: "single",
      from: { userid: "u" },
      msgtype: "file",
      file: { url: "https://x" },
    })
  )
  assert.equal(env!.message.plainText, "[文件]")
})

test("mixed text+image flattens with placeholder", () => {
  const env = normalizeWecomFrame(
    buildFrame({
      msgid: "m-mix",
      chattype: "single",
      from: { userid: "u" },
      msgtype: "mixed",
      mixed: {
        msg_item: [
          { msgtype: "text", text: { content: "hi " } },
          { msgtype: "image", image: { url: "x" } },
          { msgtype: "text", text: { content: " bye" } },
        ],
      },
    })
  )
  // derivePlainText joins fragments with " " and trims — so the canonical
  // plainText is what we assert here (not a verbatim concatenation).
  assert.match(env!.message.plainText, /hi/)
  assert.match(env!.message.plainText, /\[图片\]/)
  assert.match(env!.message.plainText, /bye/)
})

test("voice message uses ASR content as text", () => {
  const env = normalizeWecomFrame(
    buildFrame({
      msgid: "m-v",
      chattype: "single",
      from: { userid: "u" },
      msgtype: "voice",
      voice: { content: "transcribed audio" },
    })
  )
  assert.equal(env!.message.plainText, "transcribed audio")
})

test("unknown msgtype produces explicit placeholder", () => {
  const env = normalizeWecomFrame(
    buildFrame({
      msgid: "m-x",
      chattype: "single",
      from: { userid: "u" },
      msgtype: "future_type",
    })
  )
  assert.match(env!.message.plainText, /暂不支持的消息类型/)
})

test("raw preserves full frame for downstream metadata flow", () => {
  const frame = buildFrame(
    {
      msgid: "m",
      chattype: "single",
      from: { userid: "u" },
      msgtype: "text",
      text: { content: "x" },
      response_url: "https://qyapi.weixin.qq.com/cgi-bin/aibot/response?...",
      create_time: 1700000000,
    },
    "req-abc"
  )
  const env = normalizeWecomFrame(frame)
  assert.ok(env)
  // Whole frame stashed under raw — ingest.ts then spreads it into
  // conversation_items.metadata at top level (`{...envelope.raw}`).
  assert.equal(
    (env!.raw as { headers: { req_id: string } }).headers.req_id,
    "req-abc"
  )
  assert.equal(
    (env!.raw as { body: { response_url: string } }).body.response_url,
    "https://qyapi.weixin.qq.com/cgi-bin/aibot/response?..."
  )
})

test("create_time becomes ISO receivedAt", () => {
  const env = normalizeWecomFrame(
    buildFrame({
      msgid: "m",
      chattype: "single",
      from: { userid: "u" },
      msgtype: "text",
      text: { content: "x" },
      create_time: 1700000000,
    })
  )
  assert.equal(env!.receivedAt, new Date(1700000000 * 1000).toISOString())
})
