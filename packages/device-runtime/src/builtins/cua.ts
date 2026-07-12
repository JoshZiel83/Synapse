// CUA builtin (§4.5 / spec §10). The runtime spawns the Go
// synapse-device-cua-helper sidecar (which binds DeskAct) and proxies tools
// to it over newline-delimited JSON-RPC 2.0. The helper binary is shipped
// alongside the device runtime; the path is resolved from
// SYNAPSE_DEVICE_CUA_HELPER_PATH or the `helperPath` option.
//
// Phase 1 surface (post session-focus refactor):
//   read tools:  cua_list_displays, cua_capture_display,
//                cua_list_windows, cua_get_focus, cua_capture_view,
//                cua_set_focus            (background-only; no foreground grab)
//   write tools: cua_click, cua_type_text (see CUA_WRITE_TOOLS in
//                @synapse/device-protocol — single source of truth, shared
//                with capability-projection's grant classifier)
//
// Coordinate semantics are session-keyed: each Agent session keeps its own
// focus (display or background-window) in the Go helper's focusStore. The
// server signs a `cua_focus_scope_id` into every cua envelope; this builtin
// fails closed if that field is missing when an envelope is present, and
// forwards it as `session_id` in every sidecar RPC call.

import type { CatalogProvider, CatalogToolInvocationResult } from "../types.js"
import type {
  DeviceCatalogExposure,
  DeviceCatalogTool,
  RuntimeMcpErrorCode,
  SynapseError,
} from "@synapse/device-protocol"
import {
  CUA_WRITE_TOOLS,
  RUNTIME_MCP_ERROR_CODES,
} from "@synapse/device-protocol"
import {
  startSidecar,
  type SidecarHandle,
  type SidecarOptions,
} from "../sidecar.js"
import { toolErrorResult } from "../mcp-host.js"

const PROVIDER_KEY = "builtin.cua"

const DEVICE_ERROR_CODE_SET = new Set<RuntimeMcpErrorCode>(
  RUNTIME_MCP_ERROR_CODES
)

// ───────────────────────────── legacy tools (kept) ──────────────────────────

const LIST_DISPLAYS_TOOL: DeviceCatalogTool = {
  stable_key: "cua/list-displays",
  name: "cua_list_displays",
  description:
    "List the device's attached displays with size + scale. Subject to runtime authorization grants of capability='cua' with access='read' or 'write'.",
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
    "Capture the contents of a display as a PNG. Returns the image base64-encoded plus its pixel dimensions. Kept for backwards compatibility; new code should call cua_set_focus(target='display', display_index=N) + cua_capture_view.",
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
    "Move the mouse to (x, y) and click. Coordinate interpretation FOLLOWS the current session focus (see cua_set_focus / cua_get_focus): display focus → display-local pixels; window focus (background) → window pixels. Default focus is display 0. NOTE: this is a behavior change vs. v2 where (x, y) were always global physical pixels; multi-display callers should call cua_set_focus first. Subject to runtime authorization grants of capability='cua' with access='write'.",
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
    "Type a string at the input target dictated by the current session focus. Display focus → focused control on the OS (uses keyboard.Type with pid fallback). Window-background focus → directed injection into the focused window's PID via UnicodeTypeWithWindow. Subject to runtime authorization grants of capability='cua' with access='write'.",
  input_schema: {
    type: "object",
    properties: {
      text: { type: "string" },
      pid: {
        type: "integer",
        description:
          "Target process id (display focus only). Ignored under window-background focus, where PID is taken from the focused window.",
      },
    },
    required: ["text"],
  },
}

// ───────────────────────────── focus-aware tools (new) ──────────────────────

const LIST_WINDOWS_TOOL: DeviceCatalogTool = {
  stable_key: "cua/list-windows",
  name: "cua_list_windows",
  description:
    "List visible top-level windows on the device. Use the returned window_id (decimal string) with cua_set_focus(target='window'). Subject to runtime authorization grants of capability='cua' with access='read' or 'write'.",
  input_schema: {
    type: "object",
    properties: {},
    required: [],
  },
}

const SET_FOCUS_TOOL: DeviceCatalogTool = {
  stable_key: "cua/set-focus",
  name: "cua_set_focus",
  description:
    "Set the current session's CUA focus to a display or a background window. AFTER calling this you MUST call cua_capture_view before any cua_click/cua_type_text — the coordinate system (display_pixels vs window_pixels) and generation will have changed. Phase 1 only supports mode='background' for windows; foreground/raise/restore will land in Phase 2 (cua_window_op). pid is NOT accepted — the sidecar resolves it from window_id via ListWindows to preserve the 'screenshot window = input target' invariant. Subject to runtime authorization grants of capability='cua' with access='read' or 'write'.",
  input_schema: {
    type: "object",
    properties: {
      target: { type: "string", enum: ["display", "window"] },
      mode: {
        type: "string",
        enum: ["background"],
        description:
          "Window mode. Phase 1 supports only 'background'; foreground raise/focus is a Phase 2 capability.",
      },
      display_index: {
        type: "integer",
        description: "Required when target='display'.",
      },
      window_id: {
        type: "string",
        description:
          "Required when target='window'. Decimal string (avoids JS 53-bit precision); hex with 0x prefix also accepted.",
      },
    },
    required: ["target"],
  },
}

const GET_FOCUS_TOOL: DeviceCatalogTool = {
  stable_key: "cua/get-focus",
  name: "cua_get_focus",
  description:
    "Return the current session's CUA focus state — target, coordinate_space, generation, and (for windows) pid/title/bounds. Subject to runtime authorization grants of capability='cua' with access='read' or 'write'.",
  input_schema: {
    type: "object",
    properties: {},
    required: [],
  },
}

const CAPTURE_VIEW_TOOL: DeviceCatalogTool = {
  stable_key: "cua/capture-view",
  name: "cua_capture_view",
  description:
    "Capture the current focus target (display or focused background window) as a PNG and return its dims + coordinate_space + generation. For window focus the sidecar forces a backend that matches ClickWithWindow's coordinate system (Win=PrintWindow, mac=CGWindowList, linux=XComposite); auto-fallback is disabled. The returned (width, height) MUST match the coordinate space you pass to cua_click. Subject to runtime authorization grants of capability='cua' with access='read' or 'write'.",
  input_schema: {
    type: "object",
    properties: {},
    required: [],
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
  /**
   * Test-only seam. Lets unit tests substitute a fake SidecarHandle so they
   * can assert the params shipped to the helper (session_id injection,
   * envelope-driven overrides, etc.) without spawning a real subprocess.
   * Pass `helperPath: "/tmp/unused"` alongside this — ensureHandle still
   * requires a non-empty path before delegating to the factory, mirroring
   * the production code path.
   */
  sidecarFactory?: (opts: SidecarOptions) => SidecarHandle
}

interface CuaToolMeta {
  toolName: string
  rpcMethod: string
}

export const TOOL_META: Record<string, CuaToolMeta> = {
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
  cua_list_windows: { toolName: "cua_list_windows", rpcMethod: "list_windows" },
  cua_set_focus: { toolName: "cua_set_focus", rpcMethod: "set_focus" },
  cua_get_focus: { toolName: "cua_get_focus", rpcMethod: "get_focus" },
  cua_capture_view: {
    toolName: "cua_capture_view",
    rpcMethod: "capture_view",
  },
}

const WRITE_TOOL_SET = new Set<string>(CUA_WRITE_TOOLS)

/**
 * Map an arbitrary string from a sidecar's `error.data.synapse_code` to a
 * canonical SynapseError code. Restricted to device-side MCP codes —
 * sidecars must NOT manufacture server-facade-only codes like
 * runtime_authorization_requested. Unknown values fall through to
 * runtime_constraint with the original value preserved in details.
 */
function resolveSidecarSynapseCode(raw: unknown): {
  code: SynapseError["code"]
  rejectedRaw?: string
} {
  if (typeof raw !== "string") return { code: "runtime_constraint" }
  if (DEVICE_ERROR_CODE_SET.has(raw as RuntimeMcpErrorCode)) {
    return { code: raw as RuntimeMcpErrorCode }
  }
  return { code: "runtime_constraint", rejectedRaw: raw }
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
      const factory = opts.sidecarFactory ?? startSidecar
      handle = factory({ binaryPath })
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
            schemaVersion: 2,
          },
          tools: [
            LIST_DISPLAYS_TOOL,
            CAPTURE_DISPLAY_TOOL,
            CLICK_TOOL,
            TYPE_TEXT_TOOL,
            LIST_WINDOWS_TOOL,
            SET_FOCUS_TOOL,
            GET_FOCUS_TOOL,
            CAPTURE_VIEW_TOOL,
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
      // grant_spec; write tools (CUA_WRITE_TOOLS from device-protocol)
      // need access='write'; reads accept 'read' or 'write'.
      if (input.envelope) {
        // Fail-closed FIRST: every server-signed cua envelope MUST carry the
        // scope id. A missing field signals an API bug (forgot to call
        // deriveCuaFocusScopeId for a cua tool) — surface it as
        // invalid_request even when the grant is also missing, because the
        // grant check below would otherwise mask the server bug behind a
        // permission_denied that a UI might prompt the user to retry.
        if (!input.envelope.cua_focus_scope_id) {
          return toolErrorResult({
            code: "invalid_request",
            message:
              "cua tool envelope is missing cua_focus_scope_id — server must inject the focus scope before dispatch",
          })
        }
        // Device-side runtime authorization. Every cua tool needs a cua
        // grant_spec; write tools (CUA_WRITE_TOOLS from device-protocol)
        // need access='write'; reads accept 'read' or 'write'.
        const cuaGrants = (
          input.envelope.runtime_authorization?.grant_specs ?? []
        ).filter((g) => g.capability === "cua" && g.cua)
        const requiredAccess = WRITE_TOOL_SET.has(input.toolName)
          ? "write"
          : "read"
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
      const sidecar = ensureHandle()
      if (!sidecar) {
        return toolErrorResult({
          code: "runtime_constraint",
          message: `cua sidecar unavailable: ${startupError?.message ?? "unknown error"}`,
        })
      }
      // Build sidecar params. envelope-supplied session_id MUST override any
      // model-supplied value, so we spread input.args first and write
      // session_id last. When there's no envelope at all (loopback smoke
      // test) we fall back to "default" — but only in that case; missing
      // field with envelope present is rejected above.
      const sessionId = input.envelope?.cua_focus_scope_id ?? "default"
      const argsObject =
        input.args && typeof input.args === "object"
          ? (input.args as Record<string, unknown>)
          : {}
      const params: Record<string, unknown> = {
        ...argsObject,
        session_id: sessionId,
      }
      try {
        const result = await sidecar.request(meta.rpcMethod, params)
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          _meta: { cua_method: meta.rpcMethod },
        }
      } catch (err) {
        // Sidecar surfaced a JSON-RPC error. The diagnostic payload is on
        // err.jsonRpcData (sidecar.ts forwards frame.error.data). Map
        // synapse_code → SynapseError.code through a whitelist; preserve
        // everything else under details so dashboards see the helper's
        // backend / fallback / cua_error context.
        const e = err as Error & {
          jsonRpcCode?: number
          jsonRpcData?: unknown
        }
        const data =
          e.jsonRpcData && typeof e.jsonRpcData === "object"
            ? (e.jsonRpcData as Record<string, unknown>)
            : undefined
        const resolved = resolveSidecarSynapseCode(data?.["synapse_code"])
        const details: Record<string, unknown> = {
          cua_method: meta.rpcMethod,
          ...(typeof e.jsonRpcCode === "number"
            ? { jsonrpc_code: e.jsonRpcCode }
            : {}),
          ...(data ?? {}),
        }
        if (resolved.rejectedRaw !== undefined) {
          details.sidecar_synapse_code = resolved.rejectedRaw
        }
        return toolErrorResult({
          code: resolved.code,
          message: `cua ${meta.rpcMethod} failed: ${e.message}`,
          details,
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
