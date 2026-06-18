// CUA builtin tests. Two layers:
//
//   1. Pure behavior tests via the `sidecarFactory` seam (no subprocess).
//      Asserts envelope fail-closed, session_id injection (envelope wins
//      over model-supplied), tool-list shape, write-tool classification,
//      and structured error data forwarding.
//   2. Optional live tests against the real synapse-device-cua-helper
//      binary, gated by SYNAPSE_DEVICE_CUA_HELPER_LIVE_TEST.
//
// We deliberately do NOT trigger click/type_text in the live path — those
// side effects would be surprising on a developer workstation.

import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { existsSync } from "node:fs"
import { join } from "node:path"

import {
  CUA_WRITE_TOOLS,
  type OperationEnvelope,
} from "@synapse/device-protocol"
import { assertIsoInstantString } from "@synapse/device-protocol/instant"
import { createCuaBuiltin, TOOL_META } from "./cua.js"
import type { SidecarHandle, SidecarOptions } from "../sidecar.js"

function locateHelper(): string | null {
  const explicit = process.env.SYNAPSE_DEVICE_CUA_HELPER_PATH
  if (explicit && existsSync(explicit)) return explicit
  const candidate = join(
    process.cwd(),
    "..",
    "..",
    "sidecars",
    "cua",
    "synapse-device-cua-helper"
  )
  if (existsSync(candidate)) return candidate
  return null
}

interface CapturedCall {
  method: string
  params?: Record<string, unknown>
}

function makeFakeHandle(opts?: {
  responder?: (call: CapturedCall) => unknown
  failWith?: { code: number; message: string; data?: unknown }
}): { handle: SidecarHandle; calls: CapturedCall[] } {
  const calls: CapturedCall[] = []
  const emitter = new EventEmitter() as SidecarHandle
  emitter.request = (method: string, params?: unknown) => {
    const params2 =
      params && typeof params === "object"
        ? (params as Record<string, unknown>)
        : undefined
    calls.push({ method, params: params2 })
    if (opts?.failWith) {
      const err = new Error(
        `${opts.failWith.code}: ${opts.failWith.message}`
      ) as Error & { jsonRpcCode?: number; jsonRpcData?: unknown }
      err.jsonRpcCode = opts.failWith.code
      err.jsonRpcData = opts.failWith.data
      return Promise.reject(err)
    }
    return Promise.resolve(opts?.responder?.({ method, params: params2 }) ?? {})
  }
  emitter.notify = () => {}
  emitter.stop = async () => {}
  return { handle: emitter, calls }
}

function makeEnvelope(
  overrides: Partial<OperationEnvelope> = {}
): OperationEnvelope {
  return {
    operation_id: "00000000-0000-0000-0000-000000000001",
    attempt_id: "00000000-0000-0000-0000-000000000002",
    device_runtime_session_id: "00000000-0000-0000-0000-000000000003",
    device_capability_id: "00000000-0000-0000-0000-000000000004",
    device_exposure_id: "00000000-0000-0000-0000-000000000005",
    device_tool_id: "00000000-0000-0000-0000-000000000006",
    device_tool_revision_id: "00000000-0000-0000-0000-000000000007",
    input_hash: "deadbeef",
    task_mode: "sync",
    runtime_authorization: {
      grant_ids: ["g1"],
      grant_scope: "conversation",
      grant_specs: [{ capability: "cua", cua: { access: "write" } }],
    },
    issued_at: assertIsoInstantString(new Date().toISOString()),
    expires_at: assertIsoInstantString(
      new Date(Date.now() + 60_000).toISOString()
    ),
    signature_kid: "test",
    signature: "test-signature",
    cua_focus_scope_id: "session:my-session-id",
    ...overrides,
  }
}

test("describeExposures advertises all 8 Phase 1 tools", async () => {
  const builtin = createCuaBuiltin({ helperPath: "/tmp/unused" })
  const exposures = await builtin.describeExposures()
  assert.equal(exposures.length, 1)
  assert.equal(exposures[0]!.builtin_kind, "cua")
  const names = exposures[0]!.tools.map((t) => t.name).sort()
  assert.deepEqual(names, [
    "cua_capture_display",
    "cua_capture_view",
    "cua_click",
    "cua_get_focus",
    "cua_list_displays",
    "cua_list_windows",
    "cua_set_focus",
    "cua_type_text",
  ])
})

test("TOOL_META maps every tool to a sidecar rpc method", () => {
  for (const name of [
    "cua_list_displays",
    "cua_capture_display",
    "cua_click",
    "cua_type_text",
    "cua_list_windows",
    "cua_set_focus",
    "cua_get_focus",
    "cua_capture_view",
  ]) {
    const meta = TOOL_META[name]
    assert.ok(meta, `missing TOOL_META entry for ${name}`)
    assert.equal(meta!.toolName, name)
    assert.ok(meta!.rpcMethod.length > 0)
  }
})

test("CUA_WRITE_TOOLS classification (shared with capability-projection)", () => {
  // The shared list is the single source of truth — Phase 1 set_focus is
  // background-only so it's classified as read.
  const writes = new Set<string>(CUA_WRITE_TOOLS)
  assert.equal(writes.has("cua_click"), true)
  assert.equal(writes.has("cua_type_text"), true)
  for (const readTool of [
    "cua_list_displays",
    "cua_capture_display",
    "cua_list_windows",
    "cua_set_focus",
    "cua_get_focus",
    "cua_capture_view",
  ]) {
    assert.equal(
      writes.has(readTool),
      false,
      `${readTool} must not be a write tool in Phase 1`
    )
  }
})

test("envelope with missing cua_focus_scope_id is rejected (fail-closed)", async () => {
  const { handle, calls } = makeFakeHandle()
  const builtin = createCuaBuiltin({
    helperPath: "/tmp/unused",
    sidecarFactory: () => handle,
  })
  const envelope = makeEnvelope()
  delete (envelope as Partial<OperationEnvelope>).cua_focus_scope_id
  const result = await builtin.invokeTool!({
    toolName: "cua_get_focus",
    args: {},
    envelope,
  })
  assert.equal(result.isError, true)
  const synapseError = result._meta?.["synapse_error"] as
    | { code: string; message: string }
    | undefined
  assert.equal(synapseError?.code, "invalid_request")
  assert.match(synapseError!.message, /cua_focus_scope_id/)
  // Sidecar must NOT have been called.
  assert.equal(calls.length, 0)
})

test("missing cua_focus_scope_id takes precedence over missing grant", async () => {
  // Server-bug envelope: both fields wrong. The user's review locked the
  // ordering — invalid_request must win, otherwise a UI driven by
  // permission_denied might prompt the user to grant access to mask a
  // server-side coding bug.
  const { handle, calls } = makeFakeHandle()
  const builtin = createCuaBuiltin({
    helperPath: "/tmp/unused",
    sidecarFactory: () => handle,
  })
  const envelope = makeEnvelope({
    runtime_authorization: {
      grant_ids: [],
      grant_scope: "conversation",
      grant_specs: [], // no cua grant
    },
  })
  delete (envelope as Partial<OperationEnvelope>).cua_focus_scope_id
  const result = await builtin.invokeTool!({
    toolName: "cua_click", // write tool, would otherwise fail permission_denied
    args: { x: 1, y: 1 },
    envelope,
  })
  assert.equal(result.isError, true)
  const synapseError = result._meta?.["synapse_error"] as
    | { code: string; message: string }
    | undefined
  assert.equal(synapseError?.code, "invalid_request")
  assert.match(synapseError!.message, /cua_focus_scope_id/)
  assert.equal(calls.length, 0)
})

test("envelope cua_focus_scope_id is injected as session_id, overriding args", async () => {
  const { handle, calls } = makeFakeHandle({
    responder: () => ({ ok: true }),
  })
  const builtin = createCuaBuiltin({
    helperPath: "/tmp/unused",
    sidecarFactory: () => handle,
  })
  const envelope = makeEnvelope({
    cua_focus_scope_id: "session:from-server",
  })
  const result = await builtin.invokeTool!({
    toolName: "cua_get_focus",
    args: {
      // Adversarial model input: try to overwrite the server-signed value.
      session_id: "session:from-model",
    },
    envelope,
  })
  assert.equal(result.isError, undefined)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.method, "get_focus")
  assert.equal(calls[0]!.params?.session_id, "session:from-server")
})

test("invocation without envelope falls back to session_id='default'", async () => {
  const { handle, calls } = makeFakeHandle({
    responder: () => ({ ok: true }),
  })
  const builtin = createCuaBuiltin({
    helperPath: "/tmp/unused",
    sidecarFactory: () => handle,
  })
  const result = await builtin.invokeTool!({
    toolName: "cua_get_focus",
    args: {},
  })
  assert.equal(result.isError, undefined)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.params?.session_id, "default")
})

test("sidecar error data with whitelisted synapse_code is honored", async () => {
  const { handle } = makeFakeHandle({
    failWith: {
      code: -32602,
      message: "window not found",
      data: {
        cua_error: "window_not_found",
        synapse_code: "invalid_request",
        requested_window_id: "12345",
      },
    },
  })
  const builtin = createCuaBuiltin({
    helperPath: "/tmp/unused",
    sidecarFactory: () => handle,
  })
  const result = await builtin.invokeTool!({
    toolName: "cua_set_focus",
    args: { target: "window", window_id: "12345" },
    envelope: makeEnvelope(),
  })
  assert.equal(result.isError, true)
  const synapseError = result._meta?.["synapse_error"] as
    | {
        code: string
        message: string
        details?: Record<string, unknown>
      }
    | undefined
  assert.equal(synapseError?.code, "invalid_request")
  assert.equal(synapseError?.details?.["cua_error"], "window_not_found")
  assert.equal(synapseError?.details?.["requested_window_id"], "12345")
  assert.equal(synapseError?.details?.["jsonrpc_code"], -32602)
  // sidecar_synapse_code should NOT appear because the value was whitelisted.
  assert.equal(synapseError?.details?.["sidecar_synapse_code"], undefined)
})

test("sidecar error data with non-whitelisted synapse_code falls back to runtime_constraint", async () => {
  const { handle } = makeFakeHandle({
    failWith: {
      code: -32000,
      message: "weird",
      data: {
        cua_error: "operation_failed",
        synapse_code: "runtime_authorization_requested", // server-facade only — must NOT be honored
      },
    },
  })
  const builtin = createCuaBuiltin({
    helperPath: "/tmp/unused",
    sidecarFactory: () => handle,
  })
  const result = await builtin.invokeTool!({
    toolName: "cua_get_focus",
    args: {},
    envelope: makeEnvelope(),
  })
  assert.equal(result.isError, true)
  const synapseError = result._meta?.["synapse_error"] as
    | { code: string; details?: Record<string, unknown> }
    | undefined
  assert.equal(synapseError?.code, "runtime_constraint")
  // The rejected raw value is preserved for debugging.
  assert.equal(
    synapseError?.details?.["sidecar_synapse_code"],
    "runtime_authorization_requested"
  )
})

test("permission_denied when cua grant_specs missing required access", async () => {
  const { handle, calls } = makeFakeHandle()
  const builtin = createCuaBuiltin({
    helperPath: "/tmp/unused",
    sidecarFactory: () => handle,
  })
  // Read-only grant + write tool → permission_denied
  const envelope = makeEnvelope({
    runtime_authorization: {
      grant_ids: ["g1"],
      grant_scope: "conversation",
      grant_specs: [{ capability: "cua", cua: { access: "read" } }],
    },
  })
  const result = await builtin.invokeTool!({
    toolName: "cua_click",
    args: { x: 100, y: 100 },
    envelope,
  })
  assert.equal(result.isError, true)
  const synapseError = result._meta?.["synapse_error"] as
    | { code: string }
    | undefined
  assert.equal(synapseError?.code, "permission_denied")
  assert.equal(calls.length, 0)
})

test("cua builtin returns structured error when helper path is missing", async () => {
  const builtin = createCuaBuiltin({})
  const prior = process.env.SYNAPSE_DEVICE_CUA_HELPER_PATH
  delete process.env.SYNAPSE_DEVICE_CUA_HELPER_PATH
  try {
    const result = await builtin.invokeTool!({
      toolName: "cua_list_displays",
      args: {},
    })
    assert.equal(result.isError, true)
    const synapseError = result._meta?.["synapse_error"] as
      | { code: string; message: string }
      | undefined
    assert.equal(synapseError?.code, "runtime_constraint")
  } finally {
    if (prior !== undefined) process.env.SYNAPSE_DEVICE_CUA_HELPER_PATH = prior
  }
})

test("cua builtin proxies list_displays through the real helper when available", async () => {
  if (!process.env.SYNAPSE_DEVICE_CUA_HELPER_LIVE_TEST) return
  const helper = locateHelper()
  if (!helper) return
  const builtin = createCuaBuiltin({ helperPath: helper })
  const result = await builtin.invokeTool!({
    toolName: "cua_list_displays",
    args: {},
  })
  assert.equal(typeof result.content[0], "object")
  if (!result.isError) {
    const payload = JSON.parse(
      (result.content[0] as { type: string; text: string }).text
    ) as { displays: unknown[] }
    assert.ok(Array.isArray(payload.displays))
  }
})
