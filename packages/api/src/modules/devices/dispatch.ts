// Device dispatcher — server side. Given a (device_service_id,
// operation envelope, args), resolves the device's MCP HTTP endpoint via
// DeviceTunnelRegistry and issues a `tools/call` to it.
//
// **INTERIM IMPLEMENTATION — not the v3 data-plane terminus.** This is a
// hand-rolled JSON-RPC HTTP client, paired with the equally hand-rolled
// MCP host in `packages/device-runtime/src/mcp-host.ts`. Both will be
// swapped to `@modelcontextprotocol/sdk`'s Streamable HTTP transport
// (StreamableHttpClientTransport on this side, McpServer on the device
// side) in a dedicated follow-up — see `docs/device-runtime-v3.md` §13
// PR #N1 (Tool Data Plane → MCP SDK Streamable HTTP). The current shape
// is wire-compatible with the SDK transport so the swap is mechanical;
// today's hand-roll exists only because the surface is stateless and the
// SDK client costs ~150KB on the API side, which we don't want to pay
// until we've validated the envelope + target-id + grant flow end-to-end.

import {
  SynapseErrorSchema,
  type OperationEnvelope,
  type SynapseError,
} from "@synapse/device-protocol"
import { getDeviceTunnelRegistry } from "./tunnel-registry.js"

export interface McpDispatchResult {
  ok: boolean
  /** structured CallToolResult when ok; SynapseError when !ok */
  result?: unknown
  error?: SynapseError
}

export interface DispatchOptions {
  deviceServiceId: string
  envelope: OperationEnvelope
  args: Record<string, unknown>
  toolName: string
  /** Timeout for the synchronous tools/call (ms). */
  timeoutMs?: number
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch
}

interface CallToolResult {
  content?: unknown[]
  isError?: boolean
  _meta?: Record<string, unknown>
}

interface JsonRpcToolError {
  message: string
  data?: unknown
}

interface JsonRpcToolResponse {
  result?: CallToolResult
  error?: JsonRpcToolError
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseJsonRpcToolResponseText(
  text: string
): { ok: true; body: JsonRpcToolResponse } | { ok: false; message: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, message: "dispatch response must be valid JSON" }
  }
  if (!isRecord(parsed)) {
    return { ok: false, message: "dispatch response must be a JSON object" }
  }

  const body: JsonRpcToolResponse = {}
  const error = parsed.error
  if (error !== undefined) {
    if (!isRecord(error) || typeof error.message !== "string") {
      return {
        ok: false,
        message: "dispatch response error must be a JSON-RPC error object",
      }
    }
    body.error = {
      message: error.message,
      data: error.data,
    }
  }

  const result = parsed.result
  if (result !== undefined) {
    if (!isCallToolResult(result)) {
      return {
        ok: false,
        message: "dispatch response result must be a CallToolResult object",
      }
    }
    body.result = result
  }

  return { ok: true, body }
}

function isCallToolResult(value: unknown): value is CallToolResult {
  if (!isRecord(value)) {
    return false
  }
  if (value.content !== undefined && !Array.isArray(value.content)) {
    return false
  }
  if (value.isError !== undefined && typeof value.isError !== "boolean") {
    return false
  }
  if (value._meta !== undefined && !isRecord(value._meta)) {
    return false
  }
  return true
}

function malformedDispatchResponse(message: string): McpDispatchResult {
  return {
    ok: false,
    error: {
      code: "runtime_constraint",
      message,
    },
  }
}

export async function dispatchSyncTool(
  opts: DispatchOptions
): Promise<McpDispatchResult> {
  const registry = getDeviceTunnelRegistry()
  const endpoint = registry.resolve(opts.deviceServiceId)
  if (!endpoint) {
    return {
      ok: false,
      error: {
        code: "runtime_constraint",
        message: `no tunnel endpoint registered for device_service ${opts.deviceServiceId}`,
      },
    }
  }

  const fetchImpl = opts.fetchImpl ?? fetch
  const url = `${endpoint.internalUrl.replace(/\/$/, "")}/mcp`

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: opts.envelope.attempt_id,
        method: "tools/call",
        params: {
          name: opts.toolName,
          arguments: opts.args,
          _meta: { synapse_operation: opts.envelope },
        },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    })
    if (!res.ok) {
      return {
        ok: false,
        error: {
          code: "runtime_constraint",
          message: `dispatch HTTP ${res.status}`,
        },
      }
    }
    const parsed = parseJsonRpcToolResponseText(await res.text())
    if (!parsed.ok) {
      return malformedDispatchResponse(parsed.message)
    }
    const body = parsed.body
    if (body.error) {
      // Preserve `body.error.data` (JSON-RPC structured data) as
      // SynapseError.details so upstream details (e.g. sidecar diagnostic
      // payloads) survive across the API boundary. Without this the
      // upper layer only sees the truncated `message` string and any
      // actionable hints are lost.
      const data = body.error.data
      return {
        ok: false,
        error: {
          code: "runtime_constraint",
          message: body.error.message,
          details:
            data && typeof data === "object" && !Array.isArray(data)
              ? (data as Record<string, unknown>)
              : data !== undefined
                ? { value: data }
                : undefined,
        },
      }
    }
    const result = body.result ?? {}
    const synapseErrorCandidate = result._meta?.["synapse_error"]
    if (synapseErrorCandidate !== undefined) {
      const synapseError = SynapseErrorSchema.safeParse(synapseErrorCandidate)
      if (!synapseError.success) {
        return malformedDispatchResponse(
          "dispatch response synapse_error must match SynapseError"
        )
      }
      return { ok: false, error: synapseError.data }
    }
    return { ok: true, result }
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "runtime_constraint",
        message: `dispatch error: ${(err as Error).message}`,
      },
    }
  }
}
