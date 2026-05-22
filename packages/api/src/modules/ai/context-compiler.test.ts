// Unit tests for context-compiler: ensures the new noticeType values
// (post Phase 5 + 7a) wrap correctly in XML, and tool_result_batch /
// tool_call_batch compile straight through into the provider message
// shape without any string-prefix sneaking in.
import test from "node:test"
import assert from "node:assert/strict"

import { compileContextItemsToConversationMessages } from "./context-compiler.js"
import {
  extractText,
  textBlocks,
  type CanonicalContentBlock,
  type CanonicalContextItem,
} from "@synapse/shared"

const ASSISTANT_AUTHOR = {
  participantType: "actor" as const,
  sessionId: "sess-1",
  isSelf: true,
}

test("system_notice with noticeType=interrupt wraps as XML, no [System Interrupt - X]: prefix", async () => {
  const items: CanonicalContextItem[] = [
    {
      kind: "system_notice",
      noticeType: "interrupt",
      scope: "private",
      surface: "internal",
      parts: textBlocks("wait, I need to think"),
      metadata: { interruptType: "user_pause" },
    },
  ]
  const messages = await compileContextItemsToConversationMessages(items)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].role, "user")
  const text = extractText(
    (messages[0] as any).content as CanonicalContentBlock[]
  )
  assert.match(text, /<system_notice/)
  assert.match(text, /noticeType="interrupt"/)
  assert.match(text, /wait, I need to think/)
  assert.doesNotMatch(text, /\[System Interrupt/)
})

test("system_notice with noticeType=wakeup wraps as XML, no [Wakeup - X]: prefix", async () => {
  const items: CanonicalContextItem[] = [
    {
      kind: "system_notice",
      noticeType: "wakeup",
      scope: "private",
      surface: "internal",
      parts: textBlocks("Please reply about the chart"),
      metadata: { wakeupId: "wk-1", title: "user_message from alice" },
    },
  ]
  const messages = await compileContextItemsToConversationMessages(items)
  const text = extractText(
    (messages[0] as any).content as CanonicalContentBlock[]
  )
  assert.match(text, /noticeType="wakeup"/)
  assert.match(text, /Please reply about the chart/)
  assert.doesNotMatch(text, /\[Wakeup/)
})

test("system_notice with noticeType=task_instruction wraps as XML, no [Task Instruction]: prefix", async () => {
  const items: CanonicalContextItem[] = [
    {
      kind: "system_notice",
      noticeType: "task_instruction",
      scope: "shared",
      surface: "visible",
      parts: textBlocks("Please summarise the report"),
      metadata: {},
    },
  ]
  const messages = await compileContextItemsToConversationMessages(items)
  const text = extractText(
    (messages[0] as any).content as CanonicalContentBlock[]
  )
  assert.match(text, /noticeType="task_instruction"/)
  assert.match(text, /Please summarise the report/)
  assert.doesNotMatch(text, /\[Task Instruction\]/)
})

test("tool_call_batch becomes assistant ConversationMessage with toolCalls", async () => {
  const items: CanonicalContextItem[] = [
    {
      kind: "tool_call_batch",
      itemId: "msg-1:tool-call:0",
      sessionId: "sess-1",
      scope: "private",
      surface: "internal",
      role: "assistant",
      author: ASSISTANT_AUTHOR,
      content: textBlocks("Calling lookup..."),
      toolCalls: [
        {
          callId: "c-1",
          toolName: "lookup",
          input: { id: "abc" },
        },
      ],
    },
  ]
  const messages = await compileContextItemsToConversationMessages(items)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].role, "assistant")
  assert.equal((messages[0] as any).toolCalls.length, 1)
  assert.equal((messages[0] as any).toolCalls[0].callId, "c-1")
  assert.equal((messages[0] as any).toolCalls[0].toolName, "lookup")
})

test("tool_result_batch becomes role=tool_result ConversationMessage, preserves origin + structuredContent", async () => {
  const items: CanonicalContextItem[] = [
    {
      kind: "tool_result_batch",
      itemId: "msg-1:tool-result:0",
      sessionId: "sess-1",
      scope: "private",
      surface: "internal",
      toolResults: [
        {
          toolCallId: "c-1",
          toolName: "lookup",
          content: textBlocks("hit"),
          isError: false,
          structuredContent: { score: 0.87 },
          origin: {
            kind: "mcp_relay",
            deviceId: "dev-1",
            exposureStableKey: "synapse.builtin.filesystem.v1",
          },
        },
      ],
    },
  ]
  const messages = await compileContextItemsToConversationMessages(items)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].role, "tool_result")
  const results = (messages[0] as any).results
  assert.equal(results.length, 1)
  assert.equal(results[0].toolCallId, "c-1")
  assert.equal(results[0].origin.kind, "mcp_relay")
  assert.deepEqual(results[0].structuredContent, { score: 0.87 })
  // assert that the body never got prefixed
  assert.equal(extractText(results[0].content), "hit")
})

test("tool_result_batch with file_ref content preserves file_ref shape (no extractText reflattening)", async () => {
  const fileRef: CanonicalContentBlock = {
    type: "file_ref",
    id: "block-1",
    fileId: "00000000-0000-4000-8000-000000000001",
    url: "/files/00000000-0000-4000-8000-000000000001",
    mimeType: "image/png",
    originalName: "x.png",
    sizeBytes: 64,
    category: "image",
  }
  const items: CanonicalContextItem[] = [
    {
      kind: "tool_result_batch",
      itemId: "batch-1",
      sessionId: "sess-1",
      scope: "private",
      surface: "internal",
      toolResults: [
        {
          toolCallId: "c-1",
          toolName: "render_image",
          content: [fileRef],
          origin: { kind: "callable_plugin", pluginKey: "z-ai" },
        },
      ],
    },
  ]
  const messages = await compileContextItemsToConversationMessages(items)
  const results = (messages[0] as any).results
  assert.equal(results[0].content.length, 1)
  assert.equal(results[0].content[0].type, "file_ref")
  assert.equal(results[0].content[0].fileId, fileRef.fileId)
})

test("interleaved tool_call_batch → tool_result_batch → message keeps ordering", async () => {
  const items: CanonicalContextItem[] = [
    {
      kind: "tool_call_batch",
      itemId: "b1",
      sessionId: "s",
      scope: "private",
      surface: "internal",
      role: "assistant",
      author: ASSISTANT_AUTHOR,
      content: undefined,
      toolCalls: [{ callId: "c-1", toolName: "t", input: {} }],
    },
    {
      kind: "tool_result_batch",
      itemId: "b2",
      sessionId: "s",
      scope: "private",
      surface: "internal",
      toolResults: [
        {
          toolCallId: "c-1",
          toolName: "t",
          content: textBlocks("ok"),
          origin: { kind: "builtin", toolKind: "t" },
        },
      ],
    },
    {
      kind: "message",
      itemId: "m1",
      sessionId: "s",
      scope: "shared",
      surface: "visible",
      messageType: "assistant_message",
      role: "assistant",
      author: ASSISTANT_AUTHOR,
      parts: textBlocks("done"),
    },
  ]
  const messages = await compileContextItemsToConversationMessages(items)
  assert.equal(messages.length, 3)
  assert.equal(messages[0].role, "assistant")
  assert.equal(messages[1].role, "tool_result")
  assert.equal(messages[2].role, "assistant")
})
