import test from "node:test"
import assert from "node:assert/strict"
import { isCanonicalContentBlock } from "./index.js"
import { TRANSPORT_KINDS } from "../constants/index.js"

function mentionBlock(transportKind: string | undefined) {
  return {
    id: "block-1",
    type: "mention" as const,
    mention: {
      participantType: "external",
      name: "Alice",
      ...(transportKind === undefined
        ? {}
        : { transportKind, externalId: "alice" }),
    },
  }
}

test("isCanonicalContentBlock: accepts mention with transportKind 'feishu'", () => {
  assert.equal(isCanonicalContentBlock(mentionBlock("feishu")), true)
})

test("isCanonicalContentBlock: accepts mention with transportKind 'weixin'", () => {
  assert.equal(isCanonicalContentBlock(mentionBlock("weixin")), true)
})

test("isCanonicalContentBlock: accepts mention with transportKind 'wecom'", () => {
  assert.equal(isCanonicalContentBlock(mentionBlock("wecom")), true)
})

test("isCanonicalContentBlock: accepts mention with transportKind 'dingtalk'", () => {
  // Regression: pre-fix the validator only allowed feishu|weixin literally.
  // Without this dingtalk mentions silently dropped before reaching the
  // IM delivery worker, leaving DingTalk @s broken end-to-end.
  assert.equal(isCanonicalContentBlock(mentionBlock("dingtalk")), true)
})

test("isCanonicalContentBlock: accepts mention with undefined transportKind", () => {
  assert.equal(isCanonicalContentBlock(mentionBlock(undefined)), true)
})

test("isCanonicalContentBlock: rejects mention with unknown transportKind", () => {
  assert.equal(isCanonicalContentBlock(mentionBlock("bluesky")), false)
})

test("isCanonicalContentBlock: validator stays in sync with TRANSPORT_KINDS", () => {
  // Sanity check: every kind the enum claims to support must round-trip
  // through the validator. Adding a new TransportKind without updating
  // the validator would otherwise silently break mentions on day one.
  for (const kind of TRANSPORT_KINDS) {
    assert.equal(
      isCanonicalContentBlock(mentionBlock(kind)),
      true,
      `expected isCanonicalContentBlock to accept transportKind=${kind}`
    )
  }
})
