// Unit tests for normalizeMcpToolResult origin propagation.
//
// Verifies that the new origin parameter passes through to
// NormalizedMcpToolResult.origin (and is therefore available downstream for
// CanonicalToolResult.origin and tool_results.metadata persistence).
import test from "node:test"
import assert from "node:assert/strict"

import { normalizeMcpToolResult } from "./result-normalizer.js"
import type { ToolResultOrigin } from "@synapse/shared"

const MCP_DEVICE_ORIGIN: ToolResultOrigin = {
  kind: "runtime",
  runtimeToolId: "device-tool-1",
  runtimeName: "MacBook Pro",
  exposureStableKey: "synapse.builtin.filesystem.v1",
  visibleToolName: "View",
}

const MCP_REMOTE_ORIGIN: ToolResultOrigin = {
  kind: "plugin",
  installationId: "plugin-installation-1",
  upstreamToolName: "search",
  publisherSlug: "github",
}

const CALLABLE_PLUGIN_ORIGIN: ToolResultOrigin = {
  kind: "system",
  registryKey: "create_memory",
}

test("string result propagates origin to NormalizedMcpToolResult", async () => {
  const result = await normalizeMcpToolResult("hello", "ws-1", {
    origin: MCP_DEVICE_ORIGIN,
  })
  assert.deepEqual(result.origin, MCP_DEVICE_ORIGIN)
  assert.equal(result.content.length, 1)
  assert.equal(result.content[0].type, "text")
})

test("object result {content, isError, structuredContent} propagates origin", async () => {
  const result = await normalizeMcpToolResult(
    {
      content: [{ type: "text", text: "hello" }],
      isError: false,
      structuredContent: { ok: true },
    },
    "ws-1",
    { origin: MCP_REMOTE_ORIGIN }
  )
  assert.deepEqual(result.origin, MCP_REMOTE_ORIGIN)
  assert.equal(result.isError, false)
  assert.deepEqual(result.structuredContent, { ok: true })
})

test("array result propagates origin", async () => {
  const result = await normalizeMcpToolResult(
    [{ type: "text", text: "raw array" }],
    "ws-1",
    { origin: CALLABLE_PLUGIN_ORIGIN }
  )
  assert.deepEqual(result.origin, CALLABLE_PLUGIN_ORIGIN)
})

test("binaryMetadata preserves explicit origin", async () => {
  const result = await normalizeMcpToolResult("hello", "ws-1", {
    origin: MCP_REMOTE_ORIGIN,
    binaryMetadata: { traceId: "trc-1" },
  })
  assert.deepEqual(result.origin, MCP_REMOTE_ORIGIN)
})

test("structuredContent-only object input flows through with origin", async () => {
  const result = await normalizeMcpToolResult(
    {
      structuredContent: { score: 0.9, label: "ok" },
      isError: false,
    },
    "ws-1",
    { origin: MCP_REMOTE_ORIGIN }
  )
  assert.deepEqual(result.origin, MCP_REMOTE_ORIGIN)
  assert.deepEqual(result.structuredContent, { score: 0.9, label: "ok" })
})

test("origin kind enumeration covers all 5 documented ToolResultOrigin kinds", async () => {
  const origins: ToolResultOrigin[] = [
    { kind: "system", registryKey: "create_memory" },
    {
      kind: "plugin",
      installationId: "plugin-installation-1",
      upstreamToolName: "search",
    },
    { kind: "runtime", runtimeToolId: "device-tool-1", exposureStableKey: "e" },
    { kind: "provider_native", providerType: "openai", toolName: "web_search" },
    { kind: "model_response", providerType: "anthropic" },
  ]
  for (const origin of origins) {
    const result = await normalizeMcpToolResult("payload", "ws-1", { origin })
    assert.deepEqual(result.origin, origin, `failed for kind=${origin.kind}`)
  }
})
