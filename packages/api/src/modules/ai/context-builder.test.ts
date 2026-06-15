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

test("buildSessionContextItems: tool_result session message becomes tool_result_batch (not legacy system_notice)", () => {
  const items = buildSessionContextItems([
    {
      id: "msg-2",
      sessionId: "sess-1",
      role: "tool_result",
      contentBlocks: textBlocks("file contents: hello"),
      metadata: {
        toolCallId: "call-42",
        toolName: "View",
        origin: {
          kind: "device",
          deviceToolId: "device-tool-1",
          exposureStableKey: "synapse.builtin.filesystem.v1",
        },
        structuredContent: { path: "/tmp/x", lines: 1 },
        isError: false,
      },
    },
  ])
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, "tool_result_batch")
  const batch = items[0] as any
  assert.equal(batch.toolResults.length, 1)
  const tr = batch.toolResults[0]
  assert.equal(tr.toolCallId, "call-42")
  assert.equal(tr.toolName, "View")
  assert.equal(tr.isError, false)
  assert.deepEqual(tr.structuredContent, { path: "/tmp/x", lines: 1 })
  assert.equal(tr.origin.kind, "device")
  assert.equal(tr.origin.deviceToolId, "device-tool-1")
  const text = extractText(tr.content)
  assert.equal(text, "file contents: hello")
  assert.doesNotMatch(text, /\[Tool Result\]/)
})

test("buildSessionContextItems: tool_result row without metadata becomes tool_result_batch with synthetic ids", () => {
  const items = buildSessionContextItems([
    {
      id: "msg-legacy-1",
      sessionId: "sess-1",
      role: "tool_result",
      contentBlocks: textBlocks("legacy payload"),
      metadata: {},
    },
  ])
  assert.equal(items[0].kind, "tool_result_batch")
  const tr = (items[0] as any).toolResults[0]
  assert.equal(tr.toolCallId, "legacy-tool-call:msg-legacy-1")
  assert.equal(tr.toolName, "unknown_tool")
  assert.equal(tr.origin.kind, "system")
  assert.equal(tr.origin.registryKey, "unknown_tool")
})

test("tool_result rehydration recovers original tool metadata (residual after stripping reserved keys)", () => {
  // ai/index.ts:1249 writes the writer-flattened shape:
  //   { ...res.metadata, origin, toolCallId, toolName, providerCallId, isError, structuredContent }
  // The reader must restore CanonicalToolResult.metadata as the residual
  // (everything except the reserved keys above). The old reader looked for
  // a non-existent `innerMetadata` wrapper and silently dropped everything.
  const items = buildSessionContextItems([
    {
      id: "msg-tr-meta",
      sessionId: "sess-1",
      role: "tool_result",
      contentBlocks: textBlocks("payload"),
      metadata: {
        // reserved keys consumed by the rehydrator:
        toolCallId: "call-99",
        toolName: "lookup",
        origin: {
          kind: "plugin",
          installationId: "plugin-installation-1",
          upstreamToolName: "lookup",
        },
        structuredContent: { hits: 3 },
        isError: false,
        // residual: the original CanonicalToolResult.metadata fields
        // (mcp execution attempt info, plugin trace ids, etc.)
        attemptId: "att-1",
        traceId: "trc-deadbeef",
        latencyMs: 234,
      },
    },
  ])
  const tr = (items[0] as any).toolResults[0]
  assert.equal(tr.toolCallId, "call-99")
  assert.equal(tr.toolName, "lookup")
  assert.equal(tr.origin.installationId, "plugin-installation-1")
  assert.deepEqual(tr.structuredContent, { hits: 3 })
  // The non-reserved keys flow back into CanonicalToolResult.metadata.
  assert.equal(tr.metadata.attemptId, "att-1")
  assert.equal(tr.metadata.traceId, "trc-deadbeef")
  assert.equal(tr.metadata.latencyMs, 234)
  // Reserved keys must NOT leak into the inner metadata.
  assert.equal(tr.metadata.toolCallId, undefined)
  assert.equal(tr.metadata.origin, undefined)
  assert.equal(tr.metadata.structuredContent, undefined)
})

test("buildSessionContextItems: executionToolResults map overrides metadata-based reconstruction", () => {
  // Phase 9: when the caller pre-loads tool_calls/tool_results data, that
  // map is authoritative — the session_message.metadata is only a cached
  // projection, the execution tables are source of truth.
  const executionMap = new Map<string, any>()
  executionMap.set("call-99", {
    toolCallId: "call-99",
    toolName: "real_tool",
    content: textBlocks("authoritative payload from tool_results table"),
    isError: false,
    origin: {
      kind: "device",
      deviceToolId: "device-tool-1",
      exposureStableKey: "k",
    },
    structuredContent: { authoritative: true },
  })

  const items = buildSessionContextItems(
    [
      {
        id: "msg-x",
        sessionId: "sess-1",
        role: "tool_result",
        contentBlocks: textBlocks("stale projection text"),
        metadata: {
          toolCallId: "call-99",
          toolName: "wrong_tool_name_from_metadata",
          origin: {
            kind: "plugin",
            installationId: "wrong",
            upstreamToolName: "wrong_tool_name_from_metadata",
          },
        },
      },
    ],
    { executionToolResults: executionMap }
  )

  const tr = (items[0] as any).toolResults[0]
  assert.equal(tr.toolName, "real_tool", "tool_calls table wins over metadata")
  assert.equal(tr.origin.kind, "device", "tool_results.metadata origin wins")
  assert.deepEqual(tr.structuredContent, { authoritative: true })
  assert.equal(
    extractText(tr.content),
    "authoritative payload from tool_results table"
  )
})

test("buildSessionContextItems: missing executionToolResults entry falls back to metadata", () => {
  const executionMap = new Map<string, any>() // empty
  const items = buildSessionContextItems(
    [
      {
        id: "msg-y",
        sessionId: "sess-1",
        role: "tool_result",
        contentBlocks: textBlocks("from metadata"),
        metadata: {
          toolCallId: "call-not-in-map",
          toolName: "fallback_tool",
          origin: {
            kind: "plugin",
            installationId: "plugin-installation-1",
            upstreamToolName: "fallback_tool",
          },
        },
      },
    ],
    { executionToolResults: executionMap }
  )
  const tr = (items[0] as any).toolResults[0]
  assert.equal(tr.toolName, "fallback_tool")
  assert.equal(tr.origin.installationId, "plugin-installation-1")
})

test("buildSessionContextItems: child_result becomes tool_result_batch with child_actor origin", () => {
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
  assert.equal(items[0].kind, "tool_result_batch")
  const tr = (items[0] as any).toolResults[0]
  assert.equal(tr.toolName, "child_actor")
  assert.equal(tr.origin.kind, "system")
  assert.equal(tr.origin.registryKey, "child_actor")
  assert.equal(extractText(tr.content), "child agent reply")
})

test("conversationItemToContextItem parses only object metadata", () => {
  assert.equal(
    conversationItemToContextItem(
      {
        id: "hidden-msg",
        role: "user",
        contentBlocks: textBlocks("hidden"),
        metadata: JSON.stringify({ excludeFromContext: true }),
      },
      "actor-1"
    ),
    null
  )

  const item = conversationItemToContextItem(
    {
      id: "visible-msg",
      role: "user",
      contentBlocks: textBlocks("visible"),
      metadata: JSON.stringify(["not", "an", "object"]),
    },
    "actor-1"
  )

  assert.equal(item?.kind, "message")
  assert.deepEqual((item as any).metadata, {})
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
    sha256: "0000000000000000000000000000000000000000000000000000000000000001",
    path: "/files/x.png",
    mimeType: "image/png",
    name: "x.png",
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

test("conversationItemToContextItem: tool_result_batch via crossTurnToolHistory preserves origin + structuredContent + no string prefix", () => {
  // Validates that the structured tool_result_batch path carries the new
  // first-class fields (Phase 1+) through expandToolHistoryContextItems
  // (previously was dropping them on the floor).
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
                    structuredContent: { hit: true, score: 0.9 },
                    origin: {
                      kind: "plugin",
                      installationId: "plugin-installation-1",
                      upstreamToolName: "lookup",
                    },
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
  const tr = batch.toolResults[0]
  assert.equal(tr.toolCallId, "c-1")
  assert.deepEqual(tr.structuredContent, { hit: true, score: 0.9 })
  assert.equal(tr.origin.kind, "plugin")
  assert.equal(tr.origin.installationId, "plugin-installation-1")
  assert.equal(extractText(tr.content), "result body, no prefix")
})
