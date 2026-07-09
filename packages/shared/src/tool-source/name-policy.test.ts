import { test } from "node:test"
import assert from "node:assert/strict"
import { computeWireNames, type NamePolicyItem } from "./name-policy.js"
import {
  systemToolId,
  pluginToolId,
  runtimeToolId,
  type ToolRef,
} from "./ref.js"

function systemRef(registryKey: string): ToolRef {
  return {
    toolId: systemToolId(registryKey),
    source: { kind: "system", registryKey },
    binding: { transport: "in_process" },
    identity: { stableKey: `system/${registryKey}` },
  }
}

function pluginRef(installationId: string, upstreamToolName: string): ToolRef {
  return {
    toolId: pluginToolId(installationId, upstreamToolName),
    source: { kind: "plugin", installationId, upstreamToolName },
    binding: {
      transport: "stdio",
      instanceKey: `${installationId}:hash:turn:x`,
    },
    identity: { stableKey: `plugin/${installationId}/${upstreamToolName}` },
  }
}

function deviceRef(
  deviceToolsId: string,
  exposureStableKey: string,
  visibleName: string,
  deviceName?: string
): ToolRef {
  return {
    toolId: runtimeToolId(deviceToolsId),
    source: {
      kind: "runtime",
      runtimeToolId: deviceToolsId,
      exposureStableKey,
      ...(deviceName !== undefined ? { deviceName } : {}),
    },
    binding: {
      transport: "device_tunnel",
      runtimeId: "dev-1",
      runtimeServiceId: "svc-1",
      runtimeCapabilityId: "cap-1",
      runtimeExposureId: "exp-1",
    },
    identity: { stableKey: `device/${exposureStableKey}/${visibleName}` },
  }
}

test("globally unique leaf names stay bare", () => {
  const items: NamePolicyItem[] = [
    { ref: systemRef("send_to"), leafName: "send_to" },
    { ref: pluginRef("inst-a", "create_issue"), leafName: "create_issue" },
    {
      ref: deviceRef("dt-1", "builtin/filesystem", "fs_read"),
      leafName: "fs_read",
    },
  ]
  const reg = computeWireNames(items)
  assert.equal(reg.byToolId.get(systemToolId("send_to"))!.wireName, "send_to")
  assert.equal(
    reg.byToolId.get(pluginToolId("inst-a", "create_issue"))!.wireName,
    "create_issue"
  )
  assert.equal(reg.byToolId.get(runtimeToolId("dt-1"))!.wireName, "fs_read")
})

test("same leaf across plugin + device: BOTH qualified, neither lost (finding #2/#6)", () => {
  const pRef = pluginRef("inst-github", "read")
  const dRef = deviceRef("dt-2", "builtin/filesystem", "read", "acme-laptop")
  const items: NamePolicyItem[] = [
    { ref: pRef, leafName: "read" },
    { ref: dRef, leafName: "read" },
  ]
  const reg = computeWireNames(items)

  // Both tools survive in the registry, keyed by their distinct toolId.
  assert.equal(reg.byToolId.size, 2)
  const pWire = reg.byToolId.get(pRef.toolId)!.wireName
  const dWire = reg.byToolId.get(dRef.toolId)!.wireName

  // Neither is the bare "read" — both qualified.
  assert.notEqual(pWire, "read")
  assert.notEqual(dWire, "read")
  // Distinct wire names.
  assert.notEqual(pWire, dWire)
  // Round-trips back to the right toolId.
  assert.equal(reg.byWireName.get(pWire), pRef.toolId)
  assert.equal(reg.byWireName.get(dWire), dRef.toolId)
  // Device qualifier uses the device name.
  assert.ok(dWire.includes("acme-laptop"))
})

test("reserved provider_native name forces a colliding tool to qualify", () => {
  const pRef = pluginRef("inst-x", "web_search")
  const items: NamePolicyItem[] = [{ ref: pRef, leafName: "web_search" }]
  const reg = computeWireNames(items, ["web_search"])
  const wire = reg.byToolId.get(pRef.toolId)!.wireName
  assert.notEqual(wire, "web_search") // reserved name not stolen
  // Reserved name itself never enters the registry.
  assert.equal(reg.byWireName.has("web_search"), false)
})

test("provider-safe: illegal charset sanitized, length clamped", () => {
  const pRef = pluginRef("inst-y", "weird name/with:bad*chars")
  const items: NamePolicyItem[] = [
    { ref: pRef, leafName: "weird name/with:bad*chars" },
  ]
  const reg = computeWireNames(items)
  const wire = reg.byToolId.get(pRef.toolId)!.wireName
  assert.match(wire, /^[a-zA-Z0-9_-]+$/)
  assert.ok(wire.length <= 64)

  const longLeaf = "a".repeat(200)
  const longRef = pluginRef("inst-z", longLeaf)
  const reg2 = computeWireNames([{ ref: longRef, leafName: longLeaf }])
  assert.ok(reg2.byToolId.get(longRef.toolId)!.wireName.length <= 64)
})

test("two plugin installs with the same upstream tool name both survive", () => {
  const a = pluginRef("inst-aaaaaaaa", "search")
  const b = pluginRef("inst-bbbbbbbb", "search")
  const reg = computeWireNames([
    { ref: a, leafName: "search" },
    { ref: b, leafName: "search" },
  ])
  assert.equal(reg.byToolId.size, 2)
  const aw = reg.byToolId.get(a.toolId)!.wireName
  const bw = reg.byToolId.get(b.toolId)!.wireName
  assert.notEqual(aw, bw)
  assert.equal(reg.byWireName.get(aw), a.toolId)
  assert.equal(reg.byWireName.get(bw), b.toolId)
})
