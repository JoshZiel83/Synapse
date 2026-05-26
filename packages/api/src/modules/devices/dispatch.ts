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
  // Wall-clock timer that aborts the in-flight fetch. CRITICAL: clear it in
  // every exit path (success / HTTP error / synapse_error / catch) so the
  // process doesn't leak timers under steady load. Prior version used
  // sleep().then(abort) which left an unowned promise + timer in node's
  // queue on every successful call.
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000)

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
    clearTimeout(timer)
  }
}
