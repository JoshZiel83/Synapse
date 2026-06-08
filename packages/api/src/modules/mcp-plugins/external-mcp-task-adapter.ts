// External MCP async-tasks wire adapter (task unification, design §3.3 / §1 / step 5).
//
// This is the SINGLE isolation point for the upstream MCP "tasks" wire protocol.
// The MCP tasks feature has two incompatible shapes:
//   - 2025-11-25 (experimental, in core): client augments tools/call with
//     `task:{ttl}`; receiver returns CreateTaskResult{task}; client polls
//     tasks/get and fetches tasks/result; input via the tasks/result SSE stream.
//   - 2026-07-28 RC (extension `io.modelcontextprotocol/tasks`): server-directed
//     (polymorphic result `resultType:"task"`); tasks/result folds into tasks/get
//     (`result`/`error`); tasks/list removed; input via inputRequests + tasks/
//     update; ttl→ttlMs, pollInterval→pollIntervalMs.
//
// We design to the RC shape as the primary and treat 2025-11-25 as a legacy
// compat shim. NOTHING outside this file knows which wire version a server speaks
// — the rest of the system only sees our internal lifecycle_status ⟂ outcome.
//
// Status projection direction here is upstream→internal (an external server is
// the RECEIVER; Synapse is the requestor wrapping its task as our external_mcp
// task). The internal→MCP projection (when Synapse is the receiver, e.g. device
// tasks surfaced to an upstream MCP client) lives at the device/server edge.

import type {
  ToolCallTaskLifecycleStatus,
  ToolCallTaskOutcome,
} from "../tool-call-tasks/service.js"

/** MCP TaskStatus (identical enum across 2025-11-25 and the 2026-07-28 RC). */
export type McpTaskStatus =
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled"

export type McpTasksWireVersion = "2025-11-25" | "2026-07-28"

/** The upstream MCP Task handle, normalized across wire versions. */
export interface NormalizedMcpTask {
  taskId: string
  status: McpTaskStatus
  statusMessage?: string
  /** ms-from-creation retention (ttl / ttlMs unified). null = unlimited. */
  ttlMs: number | null
  /** suggested poll interval ms (pollInterval / pollIntervalMs unified). */
  pollIntervalMs?: number
}

/**
 * Normalize a raw upstream task object (either wire version) to NormalizedMcpTask.
 * 2025-11-25 uses `ttl`/`pollInterval`; the RC uses `ttlMs`/`pollIntervalMs`.
 */
export function normalizeMcpTask(
  raw: Record<string, unknown>,
  wireVersion: McpTasksWireVersion
): NormalizedMcpTask {
  const taskId = String(raw.taskId ?? "")
  const status = raw.status as McpTaskStatus
  const statusMessage =
    typeof raw.statusMessage === "string" ? raw.statusMessage : undefined
  const ttlMs =
    wireVersion === "2026-07-28"
      ? toNullableNumber(raw.ttlMs)
      : toNullableNumber(raw.ttl)
  const pollIntervalMs =
    wireVersion === "2026-07-28"
      ? toOptionalNumber(raw.pollIntervalMs)
      : toOptionalNumber(raw.pollInterval)
  return { taskId, status, statusMessage, ttlMs, pollIntervalMs }
}

function toNullableNumber(v: unknown): number | null {
  if (v === null) return null
  return typeof v === "number" ? v : null
}
function toOptionalNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined
}

/**
 * Project an upstream MCP task status onto our internal lifecycle_status ⟂
 * outcome. Per the MCP spec, `failed` covers BOTH (a) a JSON-RPC/execution
 * breakdown of the request itself, and (b) a tools/call whose result has
 * isError:true. Those mean different things to us:
 *   working          → working
 *   input_required   → input_required
 *   cancelled        → cancelled
 *   failed + protocol error (isJsonRpcError) → failed   (machinery breakdown;
 *                      retryable — our `failed` lane)
 *   failed (tool isError, not protocol)      → completed/tool_error  (the call
 *                      concluded with a negative result)
 *   completed        → completed/ok  (or /tool_error if the result carries
 *                      isError, mirroring device_tool semantics)
 */
export function projectMcpStatusToLifecycle(
  status: McpTaskStatus,
  opts: { resultIsError?: boolean; isJsonRpcError?: boolean } | boolean = {}
): {
  lifecycleStatus: ToolCallTaskLifecycleStatus
  outcome: ToolCallTaskOutcome | null
} {
  // Back-compat: a bare boolean is the old `resultIsError` positional arg.
  const resultIsError = typeof opts === "boolean" ? opts : opts.resultIsError
  const isJsonRpcError = typeof opts === "boolean" ? false : opts.isJsonRpcError
  switch (status) {
    case "working":
      return { lifecycleStatus: "working", outcome: null }
    case "input_required":
      return { lifecycleStatus: "input_required", outcome: null }
    case "cancelled":
      return { lifecycleStatus: "cancelled", outcome: null }
    case "failed":
      return isJsonRpcError
        ? { lifecycleStatus: "failed", outcome: null }
        : { lifecycleStatus: "completed", outcome: "tool_error" }
    case "completed":
      return {
        lifecycleStatus: "completed",
        outcome: resultIsError ? "tool_error" : "ok",
      }
    default:
      return { lifecycleStatus: "working", outcome: null }
  }
}

/**
 * The client-side surface the executor needs from an upstream MCP connection,
 * abstracted so the device-control-plane / a2a-remote-agent adapters stay
 * separate (design: three independent, separately-versioned wire adapters).
 * A concrete implementation wraps @modelcontextprotocol/sdk once the SDK speaks
 * the tasks extension; until then this interface documents the contract and is
 * exercised by unit tests against a fake.
 */
export interface McpTaskClient {
  wireVersion: McpTasksWireVersion
  /** Poll the upstream task (tasks/get). Returns the normalized handle. */
  getTask(taskId: string): Promise<NormalizedMcpTask>
  /**
   * Fetch the terminal result. On the RC this is folded into tasks/get
   * (`result`/`error`); on 2025-11-25 it is the separate tasks/result. Returns
   * the raw MCP tool-result (with optional isError).
   */
  getResult(taskId: string): Promise<{ content: unknown; isError?: boolean }>
  /** Best-effort cancel (tasks/cancel). */
  cancel(taskId: string): Promise<void>
}

const TERMINAL_MCP_STATUSES: ReadonlySet<McpTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
])

export function isMcpTaskTerminal(status: McpTaskStatus): boolean {
  return TERMINAL_MCP_STATUSES.has(status)
}
