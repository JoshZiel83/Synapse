import test from "node:test"
import assert from "node:assert/strict"
import { buildCanonicalMessage } from "./canonical-message.js"
import {
  decodeFromConversationItem,
  encodeForConversationItem,
  type EncodedContentBlock,
} from "./canonical-encoding.js"

test("encodes plain text to content + single text block + canonicalParts", () => {
  const msg = buildCanonicalMessage([{ type: "text", text: "hello" }])
  const enc = encodeForConversationItem(msg)
  assert.equal(enc.content, "hello")
  assert.deepEqual(enc.contentBlocks, [{ type: "text", text: "hello" }])
  assert.equal(enc.transportMetadata.canonicalParts.length, 1)
  assert.equal(enc.transportMetadata.schemaVersion, 1)
})

test("encodes mention with participantId as mention block", () => {
  const msg = buildCanonicalMessage([
    { type: "text", text: "hi " },
    {
      type: "mention",
      displayName: "Alice",
      participantId: "p1",
      externalId: "ou_a",
    },
  ])
  const enc = encodeForConversationItem(msg)
  assert.equal(enc.contentBlocks.length, 2)
  const mention = enc.contentBlocks[1]
  if (mention.type === "mention") {
    assert.equal(mention.mention.participantId, "p1")
    assert.equal(mention.mention.name, "Alice")
  } else {
    assert.fail("expected mention block")
  }
})

test("mention without participantId or externalId becomes plain text", () => {
  const msg = buildCanonicalMessage([{ type: "mention", displayName: "alice" }])
  const enc = encodeForConversationItem(msg)
  assert.equal(enc.contentBlocks.length, 1)
  if (enc.contentBlocks[0].type === "text") {
    assert.equal(enc.contentBlocks[0].text, "@alice")
  } else {
    assert.fail("expected text block")
  }
})

test("image with fileId+url encodes as file_ref(category=image)", () => {
  const msg = buildCanonicalMessage([
    {
      type: "image",
      fileRef: {
        fileId: "f1",
        url: "/files/f1",
        mime: "image/png",
        name: "screen.png",
        sizeBytes: 1024,
      },
    },
  ])
  const enc = encodeForConversationItem(msg)
  assert.equal(enc.contentBlocks.length, 1)
  if (enc.contentBlocks[0].type === "file_ref") {
    assert.equal(enc.contentBlocks[0].category, "image")
    assert.equal(enc.contentBlocks[0].fileId, "f1")
  } else {
    assert.fail("expected file_ref")
  }
})

test("file with mime application/pdf classifies as document", () => {
  const msg = buildCanonicalMessage([
    {
      type: "file",
      fileRef: {
        fileId: "f1",
        url: "/files/f1",
        name: "x.pdf",
        mime: "application/pdf",
      },
    },
  ])
  const enc = encodeForConversationItem(msg)
  if (enc.contentBlocks[0].type === "file_ref") {
    assert.equal(enc.contentBlocks[0].category, "document")
  } else {
    assert.fail("expected file_ref")
  }
})

test("image without fileId/url is dropped from blocks but preserved in metadata", () => {
  const msg = buildCanonicalMessage([
    { type: "text", text: "see" },
    { type: "image", fileRef: { url: "ext://x" } }, // missing fileId
  ])
  const enc = encodeForConversationItem(msg)
  // Only text block remains in contentBlocks
  assert.equal(enc.contentBlocks.length, 1)
  assert.equal(enc.contentBlocks[0].type, "text")
  // But the canonical message preserves the image
  assert.equal(enc.transportMetadata.canonicalParts.length, 2)
  assert.equal(enc.transportMetadata.canonicalParts[1].type, "image")
})

test("rich parts (card/quote/reaction) are stripped from blocks, kept in metadata", () => {
  const msg = buildCanonicalMessage([
    { type: "text", text: "hi" },
    {
      type: "card",
      schema: "feishu_interactive_v1",
      payload: { body: "x" },
      fallbackText: "card",
    },
    { type: "reaction", emoji: "👀", target: { externalMessageId: "om_t" } },
  ])
  const enc = encodeForConversationItem(msg)
  assert.equal(enc.contentBlocks.length, 1)
  assert.equal(enc.contentBlocks[0].type, "text")
  assert.equal(enc.transportMetadata.canonicalParts.length, 3)
})

test("decode prefers transportMetadata.canonicalParts when present (lossless)", () => {
  const out = decodeFromConversationItem({
    content: "plaintext fallback",
    contentBlocks: [{ type: "text", text: "lossy fallback" }],
    transportMetadata: {
      canonicalParts: [
        { type: "text", text: "rich source" },
        {
          type: "card",
          schema: "feishu_interactive_v1",
          payload: {},
          fallbackText: "card",
        },
      ],
    },
  })
  assert.equal(out.parts.length, 2)
  assert.equal(out.parts[0].type, "text")
  assert.equal(out.parts[1].type, "card")
})

test("decode falls back to contentBlocks when no metadata", () => {
  const blocks: EncodedContentBlock[] = [
    { type: "text", text: "hello " },
    {
      type: "mention",
      mention: { participantId: "p1", participantType: "user", name: "Alice" },
    },
  ]
  const out = decodeFromConversationItem({
    content: "irrelevant",
    contentBlocks: blocks,
  })
  assert.equal(out.parts.length, 2)
  if (out.parts[1].type === "mention") {
    assert.equal(out.parts[1].participantId, "p1")
    assert.equal(out.parts[1].displayName, "Alice")
  } else {
    assert.fail("expected mention part")
  }
})

test("decode falls back to content string when no blocks or metadata", () => {
  const out = decodeFromConversationItem({ content: "just text" })
  assert.equal(out.parts.length, 1)
  if (out.parts[0].type === "text") {
    assert.equal(out.parts[0].text, "just text")
  }
})

test("decode of empty input returns empty message", () => {
  const out = decodeFromConversationItem({ content: "" })
  assert.equal(out.parts.length, 0)
})

test("encode → decode round trips simple messages losslessly", () => {
  const original = buildCanonicalMessage([
    { type: "text", text: "hi " },
    { type: "mention", participantId: "p1", displayName: "Bob" },
    {
      type: "card",
      schema: "feishu_interactive_v1",
      payload: { body: "x" },
      fallbackText: "card",
    },
  ])
  const enc = encodeForConversationItem(original)
  const back = decodeFromConversationItem({
    content: enc.content,
    contentBlocks: enc.contentBlocks,
    transportMetadata: enc.transportMetadata,
  })
  assert.deepEqual(back.parts, original.parts)
})

test("file_ref with image/jpeg mime decodes as image part", () => {
  const out = decodeFromConversationItem({
    content: "[图片]",
    contentBlocks: [
      {
        type: "file_ref",
        fileId: "f",
        url: "/files/f",
        mimeType: "image/jpeg",
        originalName: "x.jpg",
        sizeBytes: 200,
        category: "image",
      },
    ],
  })
  assert.equal(out.parts[0].type, "image")
})
