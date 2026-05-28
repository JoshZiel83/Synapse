import test from "node:test"
import assert from "node:assert/strict"

import {
  TOOL_RESULT_ORIGIN_KINDS,
  canonicalToolResult,
  isToolResultOrigin,
  textBlocks,
  type CanonicalToolResult,
  type ToolResultOrigin,
} from "./index.js"

test("TOOL_RESULT_ORIGIN_KINDS enumerates all five kinds", () => {
  assert.deepEqual([...TOOL_RESULT_ORIGIN_KINDS].sort(), [
    "builtin",
    "callable_plugin",
    "mcp_device",
    "mcp_remote",
    "model_response",
  ])
})

test("isToolResultOrigin accepts each valid kind shape", () => {
  const cases: ToolResultOrigin[] = [
    { kind: "mcp_remote", serverKey: "github" },
    { kind: "mcp_remote", serverKey: "amap", serverName: "Amap MCP" },
    {
      kind: "mcp_device",
      deviceId: "dev-1",
      exposureStableKey: "synapse.builtin.filesystem.v1",
    },
    {
      kind: "mcp_device",
      deviceId: "dev-1",
      deviceName: "MacBook",
      exposureId: "exp-uuid",
      exposureStableKey: "synapse.builtin.filesystem.v1",
      exposureName: "Filesystem",
      runtimeSessionId: "rs-uuid",
      visibleToolName: "View",
      namespacedToolName: "filesystem__View",
    },
    { kind: "callable_plugin", pluginKey: "github" },
    { kind: "callable_plugin", pluginKey: "amap", pluginName: "Amap" },
    { kind: "builtin", toolKind: "memory" },
    { kind: "model_response", providerType: "anthropic" },
  ]
  for (const c of cases) {
    assert.ok(
      isToolResultOrigin(c),
      `expected origin to be valid: ${JSON.stringify(c)}`
    )
  }
})

test("isToolResultOrigin rejects malformed input", () => {
  assert.equal(isToolResultOrigin(null), false)
  assert.equal(isToolResultOrigin(undefined), false)
  assert.equal(isToolResultOrigin("mcp_device"), false)
  assert.equal(isToolResultOrigin(42), false)
  // missing discriminator
  assert.equal(isToolResultOrigin({ serverKey: "github" }), false)
  // unknown kind
  assert.equal(isToolResultOrigin({ kind: "magic", serverKey: "x" }), false)
  // missing required field per kind
  assert.equal(isToolResultOrigin({ kind: "mcp_remote" }), false)
  assert.equal(isToolResultOrigin({ kind: "mcp_device", deviceId: "x" }), false)
  assert.equal(
    isToolResultOrigin({ kind: "mcp_device", exposureStableKey: "x" }),
    false
  )
  assert.equal(isToolResultOrigin({ kind: "callable_plugin" }), false)
  assert.equal(isToolResultOrigin({ kind: "builtin" }), false)
  assert.equal(isToolResultOrigin({ kind: "model_response" }), false)
})

test("canonicalToolResult builds the minimal shape", () => {
  const r = canonicalToolResult({
    toolCallId: "call-1",
    toolName: "echo",
    content: textBlocks("hello"),
  })
  assert.equal(r.toolCallId, "call-1")
  assert.equal(r.toolName, "echo")
  assert.equal(r.content.length, 1)
  assert.equal(r.content[0].type, "text")
  // optional fields should be absent (kept undefined rather than empty)
  assert.equal(
    Object.prototype.hasOwnProperty.call(r, "structuredContent"),
    false
  )
  assert.equal(Object.prototype.hasOwnProperty.call(r, "origin"), false)
  assert.equal(Object.prototype.hasOwnProperty.call(r, "isError"), false)
  assert.equal(Object.prototype.hasOwnProperty.call(r, "metadata"), false)
  assert.equal(Object.prototype.hasOwnProperty.call(r, "providerCallId"), false)
})

test("canonicalToolResult carries all optional fields when set", () => {
  const origin: ToolResultOrigin = {
    kind: "mcp_device",
    deviceId: "dev-1",
    exposureStableKey: "synapse.builtin.filesystem.v1",
  }
  const r: CanonicalToolResult = canonicalToolResult({
    toolCallId: "call-1",
    providerCallId: "anthropic-call-1",
    toolName: "echo",
    content: textBlocks("ok"),
    structuredContent: { score: 0.9 },
    isError: true,
    origin,
    metadata: { traceId: "abc" },
  })
  assert.equal(r.providerCallId, "anthropic-call-1")
  assert.deepEqual(r.structuredContent, { score: 0.9 })
  assert.equal(r.isError, true)
  assert.deepEqual(r.origin, origin)
  assert.deepEqual(r.metadata, { traceId: "abc" })
})

test("CanonicalToolResult legacy shape (no structuredContent/origin) is still valid", () => {
  const legacy: CanonicalToolResult = {
    toolCallId: "call-1",
    toolName: "echo",
    content: textBlocks("ok"),
  }
  // structural test: should compile and the typeguard for origin should
  // not falsely match an absent value.
  assert.equal(legacy.structuredContent, undefined)
  assert.equal(legacy.origin, undefined)
  assert.equal(isToolResultOrigin(legacy.origin), false)
})
