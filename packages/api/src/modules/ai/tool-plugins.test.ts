// Unit tests for the callable tool executor. Verifies the new strict
// CallableToolResult shape: plugins may return either CanonicalContentBlock[]
// (bare blocks) or a CallableToolResult object; the executor coerces both
// into the canonical ToolResult wire shape with content: CanonicalContentBlock[].
import test from "node:test"
import assert from "node:assert/strict"

import {
  textBlocks,
  textResult,
  type CallableToolResult,
  type CanonicalContentBlock,
  type ToolCall,
} from "@synapse/shared"

import { executeCallableTools, registerToolPlugin } from "./tool-plugins.js"

function call(name: string, input: Record<string, unknown> = {}): ToolCall {
  return {
    callId: `call-${name}-${Math.random().toString(36).slice(2, 8)}`,
    providerCallId: `prov-${name}`,
    toolName: name,
    input,
  }
}

test("plugin returning CanonicalContentBlock[] flows through to ToolResult.content", async () => {
  registerToolPlugin({
    name: "blocks_only_tool",
    kind: "callable",
    definition: {
      name: "blocks_only_tool",
      description: "test",
      parameters: { type: "object", properties: {}, required: [] },
    },
    execute: async () => textBlocks("hello blocks"),
  })

  const results = await executeCallableTools([call("blocks_only_tool")])
  assert.equal(results.length, 1)
  assert.equal(results[0].toolName, "blocks_only_tool")
  assert.equal(results[0].content.length, 1)
  assert.equal(results[0].content[0].type, "text")
  assert.equal((results[0].content[0] as any).text, "hello blocks")
  assert.equal(results[0].isError, undefined)
})

test("plugin returning CallableToolResult propagates structuredContent + isError + metadata", async () => {
  registerToolPlugin({
    name: "structured_tool",
    kind: "callable",
    definition: {
      name: "structured_tool",
      description: "test",
      parameters: { type: "object", properties: {}, required: [] },
    },
    execute: async (): Promise<CallableToolResult> => ({
      content: textBlocks("see structured payload"),
      structuredContent: { score: 0.91, label: "match" },
      isError: false,
      metadata: { traceId: "trc-1" },
    }),
  })

  const results = await executeCallableTools([call("structured_tool")])
  assert.equal(results.length, 1)
  assert.deepEqual(results[0].structuredContent, {
    score: 0.91,
    label: "match",
  })
  assert.equal(results[0].isError, false)
  assert.deepEqual(results[0].metadata, { traceId: "trc-1" })
})

test("textResult() helper produces canonical CallableToolResult", async () => {
  registerToolPlugin({
    name: "text_result_helper",
    kind: "callable",
    definition: {
      name: "text_result_helper",
      description: "test",
      parameters: { type: "object", properties: {}, required: [] },
    },
    execute: async () => textResult("hello via helper", { isError: false }),
  })

  const results = await executeCallableTools([call("text_result_helper")])
  assert.equal((results[0].content[0] as any).text, "hello via helper")
  assert.equal(results[0].isError, false)
})

test("textResult() with isError true flows the flag through", async () => {
  registerToolPlugin({
    name: "error_via_helper",
    kind: "callable",
    definition: {
      name: "error_via_helper",
      description: "test",
      parameters: { type: "object", properties: {}, required: [] },
    },
    execute: async () =>
      textResult("validation failed: field is required", { isError: true }),
  })

  const results = await executeCallableTools([call("error_via_helper")])
  assert.equal(results[0].isError, true)
  assert.match((results[0].content[0] as any).text, /validation failed/)
})

test("plugin throwing wraps error message in canonical text block with isError=true", async () => {
  registerToolPlugin({
    name: "throws_tool",
    kind: "callable",
    definition: {
      name: "throws_tool",
      description: "test",
      parameters: { type: "object", properties: {}, required: [] },
    },
    execute: async () => {
      throw new Error("kaboom")
    },
  })

  const results = await executeCallableTools([call("throws_tool")])
  assert.equal(results[0].isError, true)
  assert.equal(results[0].content.length, 1)
  assert.equal(results[0].content[0].type, "text")
  assert.match((results[0].content[0] as any).text, /kaboom/)
  assert.match((results[0].content[0] as any).text, /throws_tool/)
})

test("unknown callable returns canonical text block with unknown_tool error metadata", async () => {
  const results = await executeCallableTools([call("nonexistent_tool")])
  assert.equal(results[0].isError, true)
  assert.equal(results[0].content.length, 1)
  assert.match((results[0].content[0] as any).text, /unknown callable tool/)
  const meta = results[0].metadata as any
  assert.equal(meta.toolError.code, "unknown_tool")
})

test("multiple tool calls produce results in input order", async () => {
  registerToolPlugin({
    name: "echo_a",
    kind: "callable",
    definition: {
      name: "echo_a",
      description: "test",
      parameters: { type: "object", properties: {}, required: [] },
    },
    execute: async () => textBlocks("a"),
  })
  registerToolPlugin({
    name: "echo_b",
    kind: "callable",
    definition: {
      name: "echo_b",
      description: "test",
      parameters: { type: "object", properties: {}, required: [] },
    },
    execute: async () => textBlocks("b"),
  })

  const results = await executeCallableTools([call("echo_a"), call("echo_b")])
  assert.equal(results.length, 2)
  assert.equal((results[0].content[0] as any).text, "a")
  assert.equal((results[1].content[0] as any).text, "b")
})

test("plugin returning canonical file_ref array passes through unchanged", async () => {
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
  registerToolPlugin({
    name: "returns_file_ref",
    kind: "callable",
    definition: {
      name: "returns_file_ref",
      description: "test",
      parameters: { type: "object", properties: {}, required: [] },
    },
    execute: async () => [fileRef],
  })

  const results = await executeCallableTools([call("returns_file_ref")])
  assert.equal(results[0].content.length, 1)
  assert.equal(results[0].content[0].type, "file_ref")
  assert.equal((results[0].content[0] as any).fileId, fileRef.fileId)
})
