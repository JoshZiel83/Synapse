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
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import { activeTraceparent } from "../../infrastructure/observability/traceparent.js"

/**
 * Tracer for the api→device dispatch hop (P7). fetch (undici) is NOT
 * auto-instrumented, so the outbound `tools/call` is wrapped in an explicit
 * CLIENT span below — this is the api→device edge of the distributed-trace
 * latency tree, and it is the parent the device-runtime + its sidecars
 * (cua/fs-helper) attach to via the injected `traceparent` (read inside the
 * span via `activeTraceparent()` so the device side parents under the dispatch,
 * not the bare request/job span).
 */
const tracer = trace.getTracer("synapse-device-dispatch")

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

  // Wrap the outbound tools/call in an explicit CLIENT span — this is the
  // api→device hop in the trace tree, and the active span the device side
  // continues via the injected traceparent. No-op when OTEL is disabled.
  return tracer.startActiveSpan(
    `device.dispatch ${opts.toolName}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "synapse.device_service_id": opts.deviceServiceId,
        "synapse.tool_name": opts.toolName,
        "synapse.attempt_id": opts.envelope.attempt_id,
      },
    },
    async (span): Promise<McpDispatchResult> => {
      const traceparent = activeTraceparent()
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
              _meta: traceparent
                ? { synapse_operation: opts.envelope, traceparent }
                : { synapse_operation: opts.envelope },
            },
          }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
        })
        if (!res.ok) {
          span.setAttribute("http.response.status_code", res.status)
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `dispatch HTTP ${res.status}`,
          })
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
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: parsed.message,
          })
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
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: body.error.message,
          })
          const details = ((): Record<string, unknown> | undefined => {
            if (data && typeof data === "object" && !Array.isArray(data)) {
              return data as Record<string, unknown>
            }
            if (data !== undefined) {
              return { value: data }
            }
            return undefined
          })()
          return {
            ok: false,
            error: {
              code: "runtime_constraint",
              message: body.error.message,
              details,
            },
          }
        }
        const result = body.result ?? {}
        const synapseErrorCandidate = result._meta?.["synapse_error"]
        if (synapseErrorCandidate !== undefined) {
          const synapseError = SynapseErrorSchema.safeParse(
            synapseErrorCandidate
          )
          if (!synapseError.success) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message:
                "dispatch response synapse_error must match SynapseError",
            })
            return malformedDispatchResponse(
              "dispatch response synapse_error must match SynapseError"
            )
          }
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: synapseError.data.code,
          })
          return { ok: false, error: synapseError.data }
        }
        return { ok: true, result }
      } catch (err) {
        span.recordException(err as Error)
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: `dispatch error: ${(err as Error).message}`,
        })
        return {
          ok: false,
          error: {
            code: "runtime_constraint",
            message: `dispatch error: ${(err as Error).message}`,
          },
        }
      } finally {
        span.end()
      }
    }
  )
}
