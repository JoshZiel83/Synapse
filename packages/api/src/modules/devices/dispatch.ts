// Device dispatcher — server side. Given a (runtime_service_id,
// operation envelope, args), resolves the device's MCP HTTP endpoint via
// RuntimeEndpointRegistry and issues a `tools/call` to it.
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
//
// NOTE (trace plan §4.G, MANDATORY for the SDK swap): the outbound HTTP hop
// below runs under `suppressTracing` so UndiciInstrumentation emits no
// duplicate CLIENT span and injects no headers — the manual `tools/call`
// span + the `_meta` carrier are the ONLY api→device trace edge. The
// planned Streamable-HTTP swap MUST preserve that suppressTracing wrap
// around whatever transport the SDK client uses, or the double-span +
// header/`_meta` id split this file fixes will come back.

import {
  SynapseErrorSchema,
  type OperationEnvelope,
  type SynapseError,
} from "@synapse/device-protocol"
import { getRuntimeEndpointRegistry } from "./tunnel-registry.js"
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import { suppressTracing } from "@opentelemetry/core"
import { activeTraceCarrier } from "../../infrastructure/observability/traceparent.js"

/**
 * Tracer for the api→device dispatch hop. fetch (undici) IS
 * auto-instrumented (the old "fetch is NOT auto-instrumented" claim here is
 * what caused the duplicate-span bug), so the outbound `tools/call` keeps
 * ONE manual CLIENT span — the single api→device edge of the trace tree —
 * and wraps the fetch itself in `suppressTracing` so the undici
 * instrumentation neither emits a sibling `POST` span nor injects HTTP
 * trace headers. The device side parents under this span via the
 * `{traceparent, tracestate}` carrier minted INSIDE it (`activeTraceCarrier()`
 * → `_meta`), never via HTTP headers.
 *
 * Span naming/attributes pin the OTel MCP semconv (`mcp.method.name`,
 * `mcp.tool.name`, span name `tools/call {tool}`) — Development stability as
 * of semconv 1.41; revisit on semconv upgrades.
 */
const tracer = trace.getTracer("synapse-device-dispatch")

export interface McpDispatchResult {
  ok: boolean
  /** structured CallToolResult when ok; SynapseError when !ok */
  result?: unknown
  error?: SynapseError
}

export interface DispatchOptions {
  runtimeServiceId: string
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
  const registry = getRuntimeEndpointRegistry()
  const endpoint = registry.resolve(opts.runtimeServiceId)
  if (!endpoint) {
    return {
      ok: false,
      error: {
        code: "runtime_constraint",
        message: `no tunnel endpoint registered for device_service ${opts.runtimeServiceId}`,
      },
    }
  }

  // Hard-refuse any non-http(s) endpoint scheme (inv-39). A bare (Mode-B)
  // data_plane_endpoint is scheme-tagged non-dialable (inprocess:/docker-exec:)
  // and is NEVER registered in the tunnel registry, so it can't reach here — but
  // defend in depth so such a string can never be handed to fetch().
  const scheme = endpoint.internalUrl.split(":", 1)[0]?.toLowerCase()
  if (scheme !== "http" && scheme !== "https") {
    return {
      ok: false,
      error: {
        code: "runtime_constraint",
        message: `refusing to dispatch to non-http(s) endpoint scheme '${scheme ?? ""}:'`,
      },
    }
  }

  const fetchImpl = opts.fetchImpl ?? fetch
  const url = `${endpoint.internalUrl.replace(/\/$/, "")}/mcp`
  // server.address/server.port for the CLIENT span. Never throw pre-span on a
  // malformed registry URL — fetch below surfaces it as a caught dispatch
  // error inside the span instead.
  const target = ((): URL | undefined => {
    try {
      return new URL(url)
    } catch {
      return undefined
    }
  })()
  const targetPort = ((): number | undefined => {
    if (!target) return undefined
    if (target.port) return Number(target.port)
    return target.protocol === "https:" ? 443 : 80
  })()

  // The single api→device CLIENT edge (trace plan §4.G change 1): MCP-semconv
  // span name `tools/call {tool}`; the fetch below runs under suppressTracing
  // so no undici sibling span / HTTP header injection exists. The device side
  // continues this span via the `_meta` carrier. No-op when OTEL is disabled.
  return tracer.startActiveSpan(
    `tools/call ${opts.toolName}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "mcp.method.name": "tools/call",
        "mcp.tool.name": opts.toolName,
        ...(target && targetPort !== undefined
          ? {
              "server.address": target.hostname,
              "server.port": targetPort,
            }
          : {}),
        "synapse.runtime_service_id": opts.runtimeServiceId,
        "synapse.attempt_id": opts.envelope.attempt_id,
      },
    },
    async (span): Promise<McpDispatchResult> => {
      // Minted INSIDE the span so the device side parents under the dispatch
      // edge, not the bare request/job span. {traceparent, tracestate?} with
      // the tracestate already two-stage sanitized (§3c) — never the global
      // propagator (no sentry-trace/baggage in message payloads).
      const carrier = activeTraceCarrier()
      try {
        // suppressTracing wraps ONLY the fetch: UndiciInstrumentation sees a
        // suppressed context → no duplicate CLIENT span, no header injection
        // (spike P-G). The manual span above still records + exports.
        const res = await context.with(suppressTracing(context.active()), () =>
          fetchImpl(url, {
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
                // SEP-414 reserves the unprefixed `traceparent`/`tracestate`/
                // `baggage` `_meta` keys — the carrier below conforms.
                // `synapse_operation` is a pre-existing custom unprefixed key
                // that deliberately does NOT follow MCP's `_meta` prefix
                // convention (both ends are Synapse-owned).
                _meta: { synapse_operation: opts.envelope, ...(carrier ?? {}) },
              },
            }),
            signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
          })
        )
        if (!res.ok) {
          span.setAttribute("http.response.status_code", res.status)
          span.setAttribute("error.type", String(res.status))
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
          span.setAttribute("error.type", "malformed_response")
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
          span.setAttribute("error.type", "jsonrpc_error")
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
            span.setAttribute("error.type", "malformed_response")
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message:
                "dispatch response synapse_error must match SynapseError",
            })
            return malformedDispatchResponse(
              "dispatch response synapse_error must match SynapseError"
            )
          }
          span.setAttribute("error.type", synapseError.data.code)
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: synapseError.data.code,
          })
          return { ok: false, error: synapseError.data }
        }
        return { ok: true, result }
      } catch (err) {
        span.recordException(err as Error)
        span.setAttribute("error.type", (err as Error)?.name || "Error")
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
