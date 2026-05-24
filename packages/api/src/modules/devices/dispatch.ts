// Device dispatcher — server side. Given a (device_service_id,
// operation envelope, args), resolves the device's MCP HTTP endpoint via
// DeviceTunnelRegistry and issues a `tools/call` to it.
//
// v3.0 skeleton: uses fetch directly to keep the dependency surface minimal.
// PR #7 swaps to the @modelcontextprotocol/sdk client so we get session
// management + streaming for free.

import { setTimeout as sleep } from "node:timers/promises"
import type { OperationEnvelope, SynapseError } from "@synapse/device-protocol"
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
  const controller = new AbortController()
  const timer = sleep(opts.timeoutMs ?? 60_000).then(() => controller.abort())

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
      signal: controller.signal,
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
    const body = (await res.json()) as {
      result?: CallToolResult
      error?: { code: number; message: string; data?: unknown }
    }
    if (body.error) {
      return {
        ok: false,
        error: {
          code: "runtime_constraint",
          message: body.error.message,
        },
      }
    }
    const result = body.result ?? {}
    const synapseError = result._meta?.["synapse_error"] as
      | SynapseError
      | undefined
    if (synapseError) {
      return { ok: false, error: synapseError }
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
  } finally {
    void timer
  }
}
