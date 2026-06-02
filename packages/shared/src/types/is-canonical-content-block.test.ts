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

// ── file_ref blocks (file-service refactor) ──────────────────────────────────
// Regression: isCanonicalContentBlock is used as a STRICT FILTER in
// chat/event-registry.ts and chat/message-content.ts. After the FileRefBlock
// redesign (sha256 mandatory, path optional, name replacing originalName,
// fileId/url dropped) the guard MUST accept the new shape and reject the old —
// otherwise every fileRefBlock() the system produces is silently dropped.

function newFileRefBlock(overrides: Record<string, unknown> = {}) {
  return {
    id: "fr-1",
    type: "file_ref" as const,
    sha256: "a".repeat(64),
    path: "/conversation/x.txt",
    mimeType: "text/plain",
    name: "x.txt",
    sizeBytes: 12,
    category: "document" as const,
    ...overrides,
  }
}

test("isCanonicalContentBlock: accepts the redesigned file_ref shape (sha256/path/name)", () => {
  assert.equal(isCanonicalContentBlock(newFileRefBlock()), true)
})

test("isCanonicalContentBlock: accepts a file_ref WITHOUT path (history ref)", () => {
  const { path: _omit, ...noPath } = newFileRefBlock()
  void _omit
  assert.equal(isCanonicalContentBlock(noPath), true)
})

test("isCanonicalContentBlock: rejects a file_ref missing sha256", () => {
  const { sha256: _omit, ...noSha } = newFileRefBlock()
  void _omit
  assert.equal(isCanonicalContentBlock(noSha), false)
})

test("isCanonicalContentBlock: rejects the OLD file_ref shape (fileId/url/originalName)", () => {
  // The pre-refactor shape must no longer pass — it lacks sha256/name.
  const oldShape = {
    id: "fr-old",
    type: "file_ref" as const,
    fileId: "11111111-1111-1111-1111-111111111111",
    url: "https://example/x",
    mimeType: "text/plain",
    originalName: "x.txt",
    sizeBytes: 12,
    category: "document" as const,
  }
  assert.equal(isCanonicalContentBlock(oldShape), false)
})
