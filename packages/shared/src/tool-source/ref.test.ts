import { test } from "node:test"
import assert from "node:assert/strict"
import {
  systemToolId,
  pluginToolId,
  runtimeToolId,
  stripForAuditSnapshot,
  stripForProvider,
  toPublicOrigin,
  originKindToSourceKind,
  type ToolRef,
} from "./ref.js"
import type { ToolDefinition } from "../types/index.js"

const deviceRef: ToolRef = {
  toolId: runtimeToolId("dt-1"),
  source: {
    kind: "runtime",
    runtimeToolId: "dt-1",
    exposureStableKey: "builtin/filesystem",
    runtimeName: "laptop",
    visibleToolName: "fs_read",
  },
  binding: {
    transport: "device_tunnel",
    runtimeId: "d-1",
    runtimeServiceId: "s-1",
    runtimeCapabilityId: "c-1",
    runtimeExposureId: "e-1",
  },
  identity: { stableKey: "builtin/filesystem/fs_read" },
}

const pluginRef: ToolRef = {
  toolId: pluginToolId("inst-1", "create_issue"),
  source: {
    kind: "plugin",
    installationId: "inst-1",
    upstreamToolName: "create_issue",
    publisherSlug: "acme",
    itemSlug: "github",
  },
  binding: { transport: "stdio", instanceKey: "inst-1:h:turn:x" },
  identity: { stableKey: "plugin/acme/github/create_issue" },
}

test("toolId constructors are deterministic", () => {
  assert.equal(systemToolId("send_to"), "system:send_to")
  assert.equal(
    pluginToolId("inst-1", "create_issue"),
    "plugin:inst-1:create_issue"
  )
  assert.equal(runtimeToolId("dt-1"), "runtime:dt-1")
})

test("stripForAuditSnapshot carries the full public source + stableKey per kind", () => {
  assert.deepEqual(stripForAuditSnapshot(deviceRef), {
    kind: "runtime",
    runtimeToolId: "dt-1",
    exposureStableKey: "builtin/filesystem",
    runtimeName: "laptop",
    visibleToolName: "fs_read",
    stableKey: "builtin/filesystem/fs_read",
  })
  assert.deepEqual(stripForAuditSnapshot(pluginRef), {
    kind: "plugin",
    installationId: "inst-1",
    upstreamToolName: "create_issue",
    publisherSlug: "acme",
    itemSlug: "github",
    stableKey: "plugin/acme/github/create_issue",
  })
  // The frozen stableKey must equal the ref's identity (the display resolver's
  // dispatch key) — no drift from re-deriving it out of the source fields.
  assert.equal(
    stripForAuditSnapshot(deviceRef).stableKey,
    deviceRef.identity.stableKey
  )
  assert.equal(
    stripForAuditSnapshot(pluginRef).stableKey,
    pluginRef.identity.stableKey
  )
})

test("toPublicOrigin projects without the binding (route-only) details", () => {
  const o = toPublicOrigin(pluginRef)
  assert.equal(o.kind, "plugin")
  // No instanceKey / binding fields leak into the public origin.
  assert.equal((o as Record<string, unknown>).instanceKey, undefined)
  assert.equal(JSON.stringify(o).includes("instanceKey"), false)
})

test("stripForProvider yields a source-free ToolDefinition with the wire name", () => {
  const def: ToolDefinition = {
    name: "create_issue",
    description: "[acme/github] Create an issue",
    parameters: { type: "object", properties: {}, required: [] },
    rawInputSchema: {
      type: "object",
      properties: { title: { type: "string" } },
    },
  }
  const out = stripForProvider({
    definition: def,
    wireName: "github__create_issue",
  })
  assert.equal(out.name, "github__create_issue")
  assert.equal(out.description, def.description)
  assert.deepEqual(out.rawInputSchema, def.rawInputSchema)
  // No provenance fields exist on the provider-facing shape. (ToolDefinition
  // doesn't index-overlap Record, so go through `unknown` for the cast.)
  assert.equal((out as unknown as Record<string, unknown>).ref, undefined)
  assert.equal((out as unknown as Record<string, unknown>).source, undefined)
})

test("originKindToSourceKind maps routed kinds, rejects non-routed", () => {
  assert.equal(originKindToSourceKind("plugin"), "plugin")
  assert.equal(originKindToSourceKind("runtime"), "runtime")
  assert.equal(originKindToSourceKind("system"), "system")
  assert.equal(originKindToSourceKind("provider_native"), null)
  assert.equal(originKindToSourceKind("model_response"), null)
})
