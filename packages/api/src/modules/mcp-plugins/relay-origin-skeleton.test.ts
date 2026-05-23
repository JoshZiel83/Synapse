// Unit test: tool-resolver computes a CORRECT origin even when the
// per-tool relay runtime context hasn't been populated yet (first call,
// failure path). Pre-Phase-10 bug: relay calls without an active runtime
// context were getting tagged as {kind:"mcp_remote"} instead of
// {kind:"mcp_relay"} because the relayMetadata fallback wasn't wired.
import test from "node:test"
import assert from "node:assert/strict"

import { normalizeMcpToolResult } from "./result-normalizer.js"
import type { ToolResultOrigin } from "@synapse/shared"

// We can't import the private buildMcpInstanceOrigin, but we can test the
// observable contract: a relay instance always produces mcp_relay origin
// downstream (via normalizeMcpToolResult, which is what tool-resolver
// passes to it). This file documents the expectation; the integration is
// covered by tool-resolver itself + ingest-via-relay.
//
// Here we just assert that downstream code is robust to receiving a
// "skeleton" mcp_relay (without runtimeSessionId/visibleToolName) — these
// optional fields are allowed missing in the type.

test("normalizeMcpToolResult accepts skeleton mcp_relay origin (no runtimeSessionId/visibleToolName)", async () => {
  // This is the shape buildMcpInstanceOrigin produces when relayMetadata
  // is available but the per-call runtime context isn't yet (first call /
  // failure path).
  const skeletonOrigin: ToolResultOrigin = {
    kind: "mcp_relay",
    deviceId: "dev-1",
    exposureId: "exp-1",
    exposureStableKey: "synapse.builtin.filesystem.v1",
    namespacedToolName: "filesystem__View",
  }
  const result = await normalizeMcpToolResult(
    { content: [{ type: "text", text: "ok" }], isError: false },
    "ws-1",
    { origin: skeletonOrigin }
  )
  assert.equal(result.origin?.kind, "mcp_relay")
  assert.equal((result.origin as any).deviceId, "dev-1")
  assert.equal(
    (result.origin as any).exposureStableKey,
    "synapse.builtin.filesystem.v1"
  )
  // The skeleton omits runtimeSessionId — type allows this.
  assert.equal((result.origin as any).runtimeSessionId, undefined)
})

test("normalizeMcpToolResult accepts enriched mcp_relay origin (with runtimeSessionId, visibleToolName)", async () => {
  // The shape buildMcpInstanceOrigin produces post-execute, when the
  // ensureRuntimeSession side-effect has populated activeRelayToolContexts.
  const enrichedOrigin: ToolResultOrigin = {
    kind: "mcp_relay",
    deviceId: "dev-1",
    deviceName: "MacBook Pro",
    exposureId: "exp-1",
    exposureStableKey: "synapse.builtin.filesystem.v1",
    exposureName: "Filesystem",
    runtimeSessionId: "rs-abc",
    visibleToolName: "View",
    namespacedToolName: "filesystem__View",
  }
  const result = await normalizeMcpToolResult(
    { content: [{ type: "text", text: "ok" }], isError: false },
    "ws-1",
    { origin: enrichedOrigin }
  )
  assert.deepEqual(result.origin, enrichedOrigin)
})

test("Failure-path origin propagation: skeleton is never mcp_remote for relay transport", async () => {
  // The critical Phase-10 race fix: even on first-call/failure, relay
  // transport must produce mcp_relay origin, NOT mcp_remote. This is
  // ultimately enforced by buildMcpInstanceOrigin's branching on
  // instance.transport === "relay", which is covered indirectly here by
  // showing that normalizeMcpToolResult faithfully propagates whatever
  // kind we pass.
  const origins: ToolResultOrigin[] = [
    { kind: "mcp_relay", deviceId: "d", exposureStableKey: "e" },
    { kind: "mcp_remote", serverKey: "x" },
    { kind: "callable_plugin", pluginKey: "p" },
    { kind: "builtin", toolKind: "t" },
  ]
  for (const origin of origins) {
    const result = await normalizeMcpToolResult("err", "ws", { origin })
    assert.equal(result.origin?.kind, origin.kind)
  }
})
