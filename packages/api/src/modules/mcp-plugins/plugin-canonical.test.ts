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
  kind: "plugin",
  installationId: "plugin-installation-1",
  upstreamToolName: "test_tool",
  itemSlug: "test-plugin",
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

test("handler returning textBlocks(text) → canonical text block + origin attribution", async () => {
  const result = await simulateHandlerInvocation(
    textBlocks("simple string result")
  )
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
      sha256: "9".repeat(64),
      path: "/conversation/generated.png",
      mimeType: "image/png",
      name: "generated.png",
      sizeBytes: 2048,
      category: "image",
    },
  ])
  assert.equal(result.content.length, 2)
  assert.equal(result.content[0].type, "text")
  assert.equal(result.content[1].type, "file_ref")
  assert.equal((result.content[1] as any).sha256, "9".repeat(64))
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
    {
      kind: "plugin",
      installationId: "plugin-installation-1",
      upstreamToolName: "search",
    },
    {
      kind: "runtime",
      runtimeToolId: "device-tool-1",
      exposureStableKey: "synapse.builtin.filesystem.v1",
    },
    { kind: "system", registryKey: "create_memory" },
    { kind: "provider_native", providerType: "openai", toolName: "web_search" },
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
        sha256: "1".repeat(64),
        path: "/conversation/generated_image.png",
        mimeType: "image/png",
        name: "generated_image.png",
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
