// Unit tests for context-builder Phase 5 changes: ensure that interrupts,
// wakeups, task instructions, and legacy tool_result session messages no
// longer have the legacy "[Tool Result]: " / "[Task Instruction]: " /
// "[System Interrupt - X]: " / "[Wakeup - X]: " string prefixes baked into
// their body parts. Semantic identification now lives on noticeType (which
// compileSystemNoticeItem wraps as an XML attribute).
import test from "node:test"
import assert from "node:assert/strict"

import {
  buildSessionContextItems,
  conversationItemToContextItem,
} from "./context-builder.js"
import {
  extractText,
  textBlocks,
  type CanonicalContentBlock,
} from "@synapse/shared"

function bodyText(item: any): string {
  return extractText(item.parts || [])
}

test("buildSessionContextItems: system message body has no [Task Instruction] prefix", () => {
  const items = buildSessionContextItems([
    {
      id: "msg-1",
      sessionId: "sess-1",
      role: "system",
      contentBlocks: textBlocks("Please summarise the report"),
      metadata: {},
    },
  ])
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, "system_notice")
  assert.equal((items[0] as any).noticeType, "task_instruction")
  const text = bodyText(items[0])
  assert.equal(text, "Please summarise the report")
  assert.doesNotMatch(text, /\[Task Instruction\]/)
})

test("buildSessionContextItems: tool_result session message has no [Tool Result] prefix", () => {
  const items = buildSessionContextItems([
    {
      id: "msg-2",
      sessionId: "sess-1",
      role: "tool_result",
      contentBlocks: textBlocks("file contents: hello"),
      metadata: {},
    },
  ])
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, "system_notice")
  assert.equal((items[0] as any).noticeType, "legacy_tool_result")
  const text = bodyText(items[0])
  assert.equal(text, "file contents: hello")
  assert.doesNotMatch(text, /\[Tool Result\]/)
})

test("buildSessionContextItems: child_result body has no prefix", () => {
  const items = buildSessionContextItems([
    {
      id: "msg-3",
      sessionId: "sess-1",
      role: "child_result",
      contentBlocks: textBlocks("child agent reply"),
      metadata: {},
    },
  ])
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, "system_notice")
  assert.equal((items[0] as any).noticeType, "generic")
  assert.equal(bodyText(items[0]), "child agent reply")
})

test("buildSessionContextItems: interrupt body has no [System Interrupt - X] prefix", () => {
  const items = buildSessionContextItems([], {
    interrupts: [{ type: "user_pause", content: "wait, I need to think" }],
  })
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, "system_notice")
  assert.equal((items[0] as any).noticeType, "interrupt")
  assert.equal((items[0] as any).metadata.interruptType, "user_pause")
  const text = bodyText(items[0])
  assert.equal(text, "wait, I need to think")
  assert.doesNotMatch(text, /System Interrupt/)
})

test("buildSessionContextItems: interrupt with contentBlocks uses them verbatim", () => {
  const fileRefBlock: CanonicalContentBlock = {
    type: "file_ref",
    id: "block-1",
    fileId: "00000000-0000-4000-8000-000000000001",
    url: "/files/00000000-0000-4000-8000-000000000001",
    mimeType: "image/png",
    originalName: "x.png",
    sizeBytes: 64,
    category: "image",
  }
  const items = buildSessionContextItems([], {
    interrupts: [
      {
        type: "user_pause",
        content: "ignored when contentBlocks present",
        contentBlocks: [
          {
            type: "text",
            id: "b1",
            text: "look at this",
          } as CanonicalContentBlock,
          fileRefBlock,
        ],
      } as any,
    ],
  })
  assert.equal(items.length, 1)
  const parts = (items[0] as any).parts as CanonicalContentBlock[]
  assert.equal(parts.length, 2)
  assert.equal(parts[1].type, "file_ref")
})

test("buildSessionContextItems: wakeup body has no [Wakeup - X] prefix and uses noticeType=wakeup", () => {
  const items = buildSessionContextItems([], {
    wakeups: [
      {
        wakeupId: "wk-1",
        sourceType: "user_message",
        sourceName: "alice",
        summary: "alice replied",
        reasonText: "Please respond about the chart",
      },
    ],
  })
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, "system_notice")
  assert.equal((items[0] as any).noticeType, "wakeup")
  const text = bodyText(items[0])
  assert.equal(text, "Please respond about the chart")
  assert.doesNotMatch(text, /\[Wakeup/)
})

test("conversationItemToContextItem: tool_result_batch via crossTurnToolHistory has no string prefix in tool result", () => {
  // Validates that the structured tool_result_batch path (the preferred
  // post-Phase-4 representation) produces well-formed batch items.
  const items = buildSessionContextItems(
    [
      {
        id: "assistant-msg",
        sessionId: "sess-1",
        role: "assistant",
        contentBlocks: textBlocks("Sure, I'll look it up."),
        metadata: {
          toolHistory: {
            rounds: [
              {
                content: textBlocks("Calling lookup..."),
                toolCalls: [
                  {
                    callId: "c-1",
                    toolName: "lookup",
                    input: { id: "abc" },
                  },
                ],
                toolResults: [
                  {
                    toolCallId: "c-1",
                    toolName: "lookup",
                    content: textBlocks("result body, no prefix"),
                    isError: false,
                  },
                ],
              },
            ],
          },
        },
      },
    ],
    { crossTurnToolHistory: true }
  )

  const batch = items.find((i) => i.kind === "tool_result_batch") as any
  assert.ok(batch, "tool_result_batch should be emitted")
  assert.equal(batch.toolResults.length, 1)
  assert.equal(batch.toolResults[0].toolCallId, "c-1")
  assert.equal(
    extractText(batch.toolResults[0].content),
    "result body, no prefix"
  )
})
