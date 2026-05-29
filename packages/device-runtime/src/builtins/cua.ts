// CUA builtin (§4.5 / spec §10). The runtime spawns the Go
// synapse-device-cua-helper sidecar (which binds DeskAct) and proxies a
// minimum-viable surface — list_displays / capture_display / click /
// type_text — to it. The helper binary is shipped alongside the device
// runtime; the path is resolved from SYNAPSE_DEVICE_CUA_HELPER_PATH or the
// `helperPath` option.

import type { CatalogProvider, CatalogToolInvocationResult } from "../types.js"
import type {
  DeviceCatalogExposure,
  DeviceCatalogTool,
} from "@synapse/device-protocol"
import { startSidecar, type SidecarHandle } from "../sidecar.js"
import { toolErrorResult } from "../mcp-host.js"

const PROVIDER_KEY = "builtin.cua"

const LIST_DISPLAYS_TOOL: DeviceCatalogTool = {
  stable_key: "cua/list-displays",
  name: "cua_list_displays",
  description:
    "List the device's attached displays with size + scale. Subject to runtime authorization grants of capability='cua'.",
  input_schema: {
    type: "object",
    properties: {},
    required: [],
  },
}

const CAPTURE_DISPLAY_TOOL: DeviceCatalogTool = {
  stable_key: "cua/capture-display",
  name: "cua_capture_display",
  description:
    "Capture the contents of a display as a PNG. Returns the image base64-encoded plus its pixel dimensions.",
  input_schema: {
    type: "object",
    properties: {
      index: {
        type: "integer",
        description: "Display index (0 = main display)",
      },
    },
    required: [],
  },
}

const CLICK_TOOL: DeviceCatalogTool = {
  stable_key: "cua/click",
  name: "cua_click",
  description:
    "Move the mouse to (x, y) in physical pixels and click. Subject to runtime authorization grants of capability='cua' with access='write'.",
  input_schema: {
    type: "object",
    properties: {
      x: { type: "integer" },
      y: { type: "integer" },
      button: {
        type: "string",
        enum: ["left", "right", "middle"],
        description: "Mouse button (defaults to left)",
      },
      double: { type: "boolean", description: "Double-click if true" },
    },
    required: ["x", "y"],
  },
}

const TYPE_TEXT_TOOL: DeviceCatalogTool = {
  stable_key: "cua/type-text",
  name: "cua_type_text",
  description:
    "Type a string at the currently focused control. Subject to runtime authorization grants of capability='cua' with access='write'.",
  input_schema: {
    type: "object",
    properties: {
      text: { type: "string" },
      pid: {
        type: "integer",
        description: "Target process id (0 for unspecified)",
      },
    },
    required: ["text"],
  },
}

export interface CuaBuiltinOptions {
  /**
   * Absolute path to the synapse-device-cua-helper binary. Falls back to
   * SYNAPSE_DEVICE_CUA_HELPER_PATH; if neither is set the builtin still
   * advertises the exposure but every tool call returns a structured
   * `runtime_constraint` error so the operator sees the misconfiguration on
   * the dashboard.
   */
  helperPath?: string
  displayName?: string
}

interface CuaToolMeta {
  toolName: string
  rpcMethod: string
}

const TOOL_META: Record<string, CuaToolMeta> = {
  cua_list_displays: {
    toolName: "cua_list_displays",
    rpcMethod: "list_displays",
  },
  cua_capture_display: {
    toolName: "cua_capture_display",
    rpcMethod: "capture_display",
  },
  cua_click: { toolName: "cua_click", rpcMethod: "click" },
  cua_type_text: { toolName: "cua_type_text", rpcMethod: "type_text" },
}

export function createCuaBuiltin(
  opts: CuaBuiltinOptions = {}
): CatalogProvider {
  let handle: SidecarHandle | null = null
  let startupError: Error | null = null

  function ensureHandle(): SidecarHandle | null {
    if (handle) return handle
    if (startupError) return null
    const binaryPath =
      opts.helperPath ?? process.env.SYNAPSE_DEVICE_CUA_HELPER_PATH
    if (!binaryPath) {
      startupError = new Error(
        "SYNAPSE_DEVICE_CUA_HELPER_PATH not set and helperPath option missing"
      )
      return null
    }
    try {
      handle = startSidecar({ binaryPath })
      return handle
    } catch (err) {
      startupError = err as Error
      return null
    }
  }

  return {
    providerKey: PROVIDER_KEY,
    async describeExposures(): Promise<DeviceCatalogExposure[]> {
      return [
        {
          stable_key: "builtin/cua",
          display_name: opts.displayName ?? "Computer Use Automation (DeskAct)",
          transport: "builtin",
          builtin_kind: "cua",
          metadata: {
            helperPath:
              opts.helperPath ??
              process.env.SYNAPSE_DEVICE_CUA_HELPER_PATH ??
              null,
            schemaVersion: 1,
          },
          tools: [
            LIST_DISPLAYS_TOOL,
            CAPTURE_DISPLAY_TOOL,
            CLICK_TOOL,
            TYPE_TEXT_TOOL,
          ],
        },
      ]
    },
    async invokeTool(input): Promise<CatalogToolInvocationResult> {
      const meta = TOOL_META[input.toolName]
      if (!meta) {
        return toolErrorResult({
          code: "invalid_request",
          message: `cua builtin does not handle ${input.toolName}`,
        })
      }
      // Device-side runtime authorization. Every cua tool needs a cua
      // grant_spec; write tools (click, type_text) need access='write'
      // and reads (list_displays, capture_display) accept 'read' or
      // 'write'.
      const writeTools = new Set(["cua_click", "cua_type_text"])
      if (input.envelope) {
        const cuaGrants = (
          input.envelope.runtime_authorization?.grant_specs ?? []
        ).filter((g) => g.capability === "cua" && g.cua)
        const requiredAccess = writeTools.has(input.toolName) ? "write" : "read"
        const allowed = cuaGrants.some((g) =>
          requiredAccess === "write"
            ? g.cua!.access === "write"
            : g.cua!.access === "read" || g.cua!.access === "write"
        )
        if (!allowed) {
          return toolErrorResult({
            code: "permission_denied",
            message: `cua ${input.toolName} requires a runtime_authorization grant with capability='cua' access='${requiredAccess}'`,
          })
        }
      }
      const handle = ensureHandle()
      if (!handle) {
        return toolErrorResult({
          code: "runtime_constraint",
          message: `cua sidecar unavailable: ${startupError?.message ?? "unknown error"}`,
        })
      }
      try {
        const result = await handle.request(meta.rpcMethod, input.args)
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          _meta: { cua_method: meta.rpcMethod },
        }
      } catch (err) {
        return toolErrorResult({
          code: "runtime_constraint",
          message: `cua ${meta.rpcMethod} failed: ${(err as Error).message}`,
        })
      }
    },
    async dispose() {
      if (handle) {
        await handle.stop()
        handle = null
      }
    },
  }
}
