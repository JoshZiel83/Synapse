import test from "node:test"
import assert from "node:assert/strict"

import { TOOL_RESULT_ORIGIN_KINDS } from "../constants/enums.js"
import {
  canonicalToolResult,
  isToolResultOrigin,
  textBlocks,
} from "../content/index.js"
import type { CanonicalToolResult, ToolResultOrigin } from "./index.js"

test("TOOL_RESULT_ORIGIN_KINDS enumerates all five kinds", () => {
  assert.deepEqual([...TOOL_RESULT_ORIGIN_KINDS].sort(), [
    "model_response",
    "plugin",
    "provider_native",
    "runtime",
    "system",
  ])
})

test("isToolResultOrigin accepts each valid kind shape", () => {
  const cases: ToolResultOrigin[] = [
    { kind: "system", registryKey: "create_memory" },
    {
      kind: "plugin",
      installationId: "plugin-1",
      upstreamToolName: "search",
      publisherSlug: "acme",
      itemSlug: "github",
    },
    {
      kind: "runtime",
      runtimeToolId: "tool-1",
      deviceName: "MacBook",
      exposureStableKey: "synapse.builtin.filesystem.v1",
      visibleToolName: "View",
    },
    { kind: "provider_native", providerType: "openai", toolName: "web_search" },
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
  assert.equal(isToolResultOrigin({ kind: "system" }), false)
  assert.equal(
    isToolResultOrigin({ kind: "plugin", installationId: "x" }),
    false
  )
  assert.equal(
    isToolResultOrigin({ kind: "runtime", runtimeToolId: "x" }),
    false
  )
  assert.equal(isToolResultOrigin({ kind: "provider_native" }), false)
  assert.equal(isToolResultOrigin({ kind: "model_response" }), false)
})

test("canonicalToolResult builds the minimal shape", () => {
  const origin: ToolResultOrigin = { kind: "system", registryKey: "echo" }
  const r = canonicalToolResult({
    toolCallId: "call-1",
    toolName: "echo",
    content: textBlocks("hello"),
    origin,
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
  assert.deepEqual(r.origin, origin)
  assert.equal(Object.prototype.hasOwnProperty.call(r, "isError"), false)
  assert.equal(Object.prototype.hasOwnProperty.call(r, "metadata"), false)
  assert.equal(Object.prototype.hasOwnProperty.call(r, "providerCallId"), false)
})

test("canonicalToolResult carries all optional fields when set", () => {
  const origin: ToolResultOrigin = {
    kind: "runtime",
    runtimeToolId: "tool-1",
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
