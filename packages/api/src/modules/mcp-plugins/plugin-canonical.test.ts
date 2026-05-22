// Unit test: builtin plugin handlers must produce BuiltinPluginExecuteResult
// shapes that normalize correctly into canonical CanonicalContentBlock[] with
// the right ToolResultOrigin attribution.
//
// This is the contract test for the BuiltinPluginHandler / SubFeature
// interface (Phase 7c) — every return shape declared in
// BuiltinPluginExecuteResult must flow through normalizeMcpToolResult into
// canonical form without losing structuredContent / isError / origin.
import test from "node:test"
import assert from "node:assert/strict"

import { normalizeMcpToolResult } from "./result-normalizer.js"
import { textBlock, textBlocks, type ToolResultOrigin } from "@synapse/shared"
import type { BuiltinPluginExecuteResult } from "./builtin/index.js"

const CALLABLE_PLUGIN_ORIGIN: ToolResultOrigin = {
  kind: "callable_plugin",
  pluginKey: "test-plugin",
  pluginName: "Test Plugin",
}

async function simulateHandlerInvocation(
  handlerReturn: BuiltinPluginExecuteResult
) {
  // Mirrors the real call chain at packages/api/src/modules/mcp-plugins/tool-resolver.ts:1318
  // where instance.execute(toolName, input, ctx) → normalizeMcpToolResult.
  return normalizeMcpToolResult(handlerReturn, "ws-test", {
    origin: CALLABLE_PLUGIN_ORIGIN,
  })
}

test("handler returning plain string → canonical text block + origin attribution", async () => {
  const result = await simulateHandlerInvocation("simple string result")
  assert.equal(result.content.length, 1)
  assert.equal(result.content[0].type, "text")
  assert.equal((result.content[0] as any).text, "simple string result")
  assert.deepEqual(result.origin, CALLABLE_PLUGIN_ORIGIN)
})

test("handler returning CanonicalContentBlock[] (e.g. mixed text + file_ref) preserves shape + origin", async () => {
  const result = await simulateHandlerInvocation([
    textBlock("here is your image"),
    {
      type: "file_ref",
      id: "block-out",
      fileId: "00000000-0000-4000-8000-000000000099",
      url: "/files/00000000-0000-4000-8000-000000000099",
      mimeType: "image/png",
      originalName: "generated.png",
      sizeBytes: 2048,
      category: "image",
    },
  ])
  assert.equal(result.content.length, 2)
  assert.equal(result.content[0].type, "text")
  assert.equal(result.content[1].type, "file_ref")
  assert.equal(
    (result.content[1] as any).fileId,
    "00000000-0000-4000-8000-000000000099"
  )
  assert.deepEqual(result.origin, CALLABLE_PLUGIN_ORIGIN)
})

test("handler returning CallableToolResult envelope flows isError + structuredContent through", async () => {
  const result = await simulateHandlerInvocation({
    content: textBlocks("API success"),
    isError: false,
    structuredContent: { rows: 42, durationMs: 87 },
  })
  assert.equal(result.content.length, 1)
  assert.equal((result.content[0] as any).text, "API success")
  assert.equal(result.isError, false)
  assert.deepEqual(result.structuredContent, { rows: 42, durationMs: 87 })
  assert.deepEqual(result.origin, CALLABLE_PLUGIN_ORIGIN)
})

test("handler returning isError=true envelope preserves the flag", async () => {
  const result = await simulateHandlerInvocation({
    content: textBlocks("API quota exceeded"),
    isError: true,
    structuredContent: { code: "rate_limited", retryAfter: 30 },
  })
  assert.equal(result.isError, true)
  assert.match((result.content[0] as any).text, /quota exceeded/)
  assert.equal((result.structuredContent as any)?.code, "rate_limited")
})

test("origin discriminator carries through for all 4 'tool_output' kinds", async () => {
  const origins: ToolResultOrigin[] = [
    { kind: "mcp_remote", serverKey: "github" },
    {
      kind: "mcp_relay",
      deviceId: "dev-1",
      exposureStableKey: "synapse.builtin.filesystem.v1",
    },
    { kind: "callable_plugin", pluginKey: "amap/openapi" },
    { kind: "builtin", toolKind: "create_memory" },
  ]
  for (const origin of origins) {
    const result = await normalizeMcpToolResult("hello", "ws", { origin })
    assert.deepEqual(
      result.origin,
      origin,
      `expected origin preserved for kind=${origin.kind}`
    )
  }
})

test("handler returning content as MCP-protocol-shaped {content:[...], structuredContent} is recognised", async () => {
  // The wire shape that built-in handlers like z-ai image-generation
  // produce when they need to expose structuredContent.
  const result = await simulateHandlerInvocation({
    content: [
      textBlock("Generated 1 image"),
      {
        type: "file_ref",
        id: "img-block",
        fileId: "00000000-0000-4000-8000-000000000010",
        url: "/files/00000000-0000-4000-8000-000000000010",
        mimeType: "image/png",
        originalName: "generated_image.png",
        sizeBytes: 4096,
        category: "image",
      },
    ],
    structuredContent: {
      images: 1,
      model: "glm-image",
    },
  })
  assert.equal(result.content.length, 2)
  assert.equal(result.content[1].type, "file_ref")
  assert.equal((result.structuredContent as any)?.model, "glm-image")
  assert.deepEqual(result.origin, CALLABLE_PLUGIN_ORIGIN)
})
