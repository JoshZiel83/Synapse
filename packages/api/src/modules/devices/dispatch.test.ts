import assert from "node:assert/strict"
import test from "node:test"

import {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
} from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import {
  isTracingSuppressed,
  TraceState,
  W3CTraceContextPropagator,
} from "@opentelemetry/core"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import {
  OperationEnvelopeSchema,
  type OperationEnvelope,
} from "@synapse/device-protocol"
import { dispatchSyncTool } from "./dispatch.js"
import {
  createInMemoryRuntimeEndpointRegistry,
  getRuntimeEndpointRegistry,
  setRuntimeEndpointRegistry,
} from "./tunnel-registry.js"

// REAL provider + in-memory exporter (trace plan §4.G change 3): the dispatch
// span must record and export so the tests can pin the single-CLIENT-edge
// contract — one `tools/call <tool>` span, carrier in `_meta` (not headers).
const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})
context.setGlobalContextManager(new AsyncLocalStorageContextManager())
trace.setGlobalTracerProvider(provider)
propagation.setGlobalPropagator(new W3CTraceContextPropagator())

const ENVELOPE: OperationEnvelope = OperationEnvelopeSchema.parse({
  operation_id: "00000000-0000-4000-8000-000000000001",
  attempt_id: "00000000-0000-4000-8000-000000000002",
  runtime_session_id: "00000000-0000-4000-8000-000000000003",
  runtime_capability_id: "00000000-0000-4000-8000-000000000004",
  runtime_exposure_id: "00000000-0000-4000-8000-000000000005",
  runtime_tool_id: "00000000-0000-4000-8000-000000000006",
  runtime_tool_revision_id: "00000000-0000-4000-8000-000000000007",
  input_hash: "sha256:test",
  task_mode: "sync",
  issued_at: "2026-01-01T00:00:00.000Z",
  expires_at: "2026-01-01T00:01:00.000Z",
  signature_kid: "kid-test",
  signature: "signature-test",
})

interface FetchCall {
  url: string
  body: Record<string, unknown>
  headers: Record<string, string>
  /**
   * Whether the fetch ran under `suppressTracing` (§4.G change 1). Recorded
   * from INSIDE the fetch impl — a fake fetch bypasses UndiciInstrumentation's
   * diagnostics-channel subscriber entirely, so the "no sibling POST span / no
   * wire headers" assertions alone would stay green even if the
   * `context.with(suppressTracing(...))` wrap in dispatch.ts were deleted.
   * This flag pins the wrap itself: it is exactly what makes the real
   * instrumentation-undici subscriber a no-op in production.
   */
  suppressed: boolean
}

function makeFetchResponse(responseText: string, status = 200) {
  const calls: FetchCall[] = []
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit
  ): Promise<Response> => {
    let url: string
    if (typeof input === "string") {
      url = input
    } else if (input instanceof URL) {
      url = input.toString()
    } else {
      url = input.url
    }
    calls.push({
      url,
      body: JSON.parse(String(init?.body)),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(
          ([k, v]) => [k.toLowerCase(), v]
        )
      ),
      suppressed: isTracingSuppressed(context.active()),
    })
    return new Response(responseText, { status })
  }) as typeof fetch
  return { fetchImpl, calls }
}

async function withRegisteredTunnel<T>(
  run: (fetchImpl: typeof fetch, calls: FetchCall[]) => Promise<T>,
  responseText: string
): Promise<T> {
  exporter.reset()
  const previousRegistry = getRuntimeEndpointRegistry()
  const registry = createInMemoryRuntimeEndpointRegistry()
  registry.register({
    runtimeServiceId: "svc-1",
    internalUrl: "http://device-runtime.local/session/",
  })
  setRuntimeEndpointRegistry(registry)
  const { fetchImpl, calls } = makeFetchResponse(responseText)
  try {
    return await run(fetchImpl, calls)
  } finally {
    setRuntimeEndpointRegistry(previousRegistry)
  }
}

function baseDispatchOptions(fetchImpl: typeof fetch) {
  return {
    runtimeServiceId: "svc-1",
    envelope: ENVELOPE,
    args: { input: "hello" },
    toolName: "tool.echo",
    timeoutMs: 1000,
    fetchImpl,
  }
}

test("dispatchSyncTool posts the operation envelope and returns object results", async () => {
  await withRegisteredTunnel(
    async (fetchImpl, calls) => {
      const result = await dispatchSyncTool(baseDispatchOptions(fetchImpl))

      assert.deepEqual(result, {
        ok: true,
        result: {
          content: [{ type: "text", text: "ok" }],
        },
      })
      assert.equal(calls[0]?.url, "http://device-runtime.local/session/mcp")
      // _meta.traceparent is the dispatch span's own dynamic ids — checked
      // separately in the single-CLIENT-edge test below.
      const body = calls[0]!.body as {
        params: { _meta: Record<string, unknown> }
      } & Record<string, unknown>
      const { traceparent, ...metaRest } = body.params._meta
      assert.equal(typeof traceparent, "string")
      assert.deepEqual(
        { ...body, params: { ...body.params, _meta: metaRest } },
        {
          jsonrpc: "2.0",
          id: ENVELOPE.attempt_id,
          method: "tools/call",
          params: {
            name: "tool.echo",
            arguments: { input: "hello" },
            _meta: { synapse_operation: ENVELOPE },
          },
        }
      )
    },
    JSON.stringify({
      result: { content: [{ type: "text", text: "ok" }] },
    })
  )
})

// ─── single-CLIENT-edge contract (trace plan §4.G changes 1+3) ──────────────

test("exactly ONE CLIENT span `tools/call <tool>`; carrier in _meta (span's own ids), NEVER in HTTP headers", async () => {
  await withRegisteredTunnel(
    async (fetchImpl, calls) => {
      const result = await dispatchSyncTool(baseDispatchOptions(fetchImpl))
      assert.equal(result.ok, true)

      const spans = exporter.getFinishedSpans()
      assert.equal(spans.length, 1, "no sibling POST span, just the edge")
      const span = spans[0]!
      assert.equal(span.name, "tools/call tool.echo")
      assert.equal(span.kind, SpanKind.CLIENT)
      assert.equal(span.attributes["mcp.method.name"], "tools/call")
      assert.equal(span.attributes["mcp.tool.name"], "tool.echo")
      assert.equal(span.attributes["server.address"], "device-runtime.local")
      assert.equal(span.attributes["server.port"], 80)
      assert.equal(span.attributes["synapse.runtime_service_id"], "svc-1")
      assert.equal(span.status.code, SpanStatusCode.UNSET)

      // the _meta carrier is the exported span's OWN ids (the device side
      // parents under the dispatch edge, not the request/job span)
      const meta = (
        calls[0]!.body as { params: { _meta: Record<string, unknown> } }
      ).params._meta
      const sc = span.spanContext()
      assert.equal(meta.traceparent, `00-${sc.traceId}-${sc.spanId}-01`)
      assert.equal(meta.tracestate, undefined)

      // NO trace headers on the wire — the fetch runs under suppressTracing
      // and dispatch never injects manually
      assert.equal(calls[0]!.headers["traceparent"], undefined)
      assert.equal(calls[0]!.headers["tracestate"], undefined)

      // ...and the wrap is pinned directly: the fetch itself must observe a
      // suppressed active context (the mechanism that silences the REAL
      // UndiciInstrumentation subscriber — see the FetchCall.suppressed doc).
      assert.equal(
        calls[0]!.suppressed,
        true,
        "dispatch fetch must run under suppressTracing"
      )
    },
    JSON.stringify({
      result: { content: [{ type: "text", text: "ok" }] },
    })
  )
})

test("_meta.tracestate present when the parent context carries TraceState (vendor member survives)", async () => {
  await withRegisteredTunnel(
    async (fetchImpl, calls) => {
      const parent = trace.setSpanContext(context.active(), {
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        traceFlags: TraceFlags.SAMPLED,
        isRemote: true,
        traceState: new TraceState("othervendor=xyz"),
      })
      const result = await context.with(parent, () =>
        dispatchSyncTool(baseDispatchOptions(fetchImpl))
      )
      assert.equal(result.ok, true)

      const span = exporter.getFinishedSpans()[0]!
      assert.equal(
        span.spanContext().traceId,
        "0af7651916cd43dd8448eb211c80319c",
        "dispatch span continues the parent trace"
      )
      const meta = (
        calls[0]!.body as { params: { _meta: Record<string, unknown> } }
      ).params._meta
      assert.equal(
        meta.traceparent,
        `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`
      )
      assert.equal(meta.tracestate, "othervendor=xyz")
      assert.equal(calls[0]!.headers["tracestate"], undefined)
    },
    JSON.stringify({
      result: { content: [{ type: "text", text: "ok" }] },
    })
  )
})

test("error.type mapping: HTTP status / jsonrpc_error / malformed_response / SynapseError code", async () => {
  // !res.ok → String(status)
  await withRegisteredTunnel(async () => {
    const { fetchImpl: failing } = makeFetchResponse("oops", 502)
    const res = await dispatchSyncTool(baseDispatchOptions(failing))
    assert.equal(res.ok, false)
    const span = exporter.getFinishedSpans().at(-1)!
    assert.equal(span.attributes["error.type"], "502")
    assert.equal(span.status.code, SpanStatusCode.ERROR)
  }, "unused")

  // JSON-RPC error object → jsonrpc_error
  await withRegisteredTunnel(
    async (fetchImpl) => {
      await dispatchSyncTool(baseDispatchOptions(fetchImpl))
      const span = exporter.getFinishedSpans().at(-1)!
      assert.equal(span.attributes["error.type"], "jsonrpc_error")
    },
    JSON.stringify({ error: { code: -32000, message: "sidecar refused" } })
  )

  // unparseable body → malformed_response
  await withRegisteredTunnel(async (fetchImpl) => {
    await dispatchSyncTool(baseDispatchOptions(fetchImpl))
    const span = exporter.getFinishedSpans().at(-1)!
    assert.equal(span.attributes["error.type"], "malformed_response")
  }, "{not-json")

  // typed synapse_error → the SynapseError code
  await withRegisteredTunnel(
    async (fetchImpl) => {
      await dispatchSyncTool(baseDispatchOptions(fetchImpl))
      const span = exporter.getFinishedSpans().at(-1)!
      assert.equal(span.attributes["error.type"], "permission_denied")
    },
    JSON.stringify({
      result: {
        content: [],
        _meta: {
          synapse_error: { code: "permission_denied", message: "no grant" },
        },
      },
    })
  )

  // thrown fetch → err.name
  await withRegisteredTunnel(async () => {
    const throwing = (async () => {
      throw new TypeError("fetch failed")
    }) as unknown as typeof fetch
    const res = await dispatchSyncTool(baseDispatchOptions(throwing))
    assert.equal(res.ok, false)
    const span = exporter.getFinishedSpans().at(-1)!
    assert.equal(span.attributes["error.type"], "TypeError")
    assert.equal(
      span.events.some((e) => e.name === "exception"),
      true
    )
  }, "unused")
})

test("dispatchSyncTool preserves JSON-RPC error data as SynapseError details", async () => {
  await withRegisteredTunnel(
    async (fetchImpl) => {
      const result = await dispatchSyncTool(baseDispatchOptions(fetchImpl))

      assert.deepEqual(result, {
        ok: false,
        error: {
          code: "runtime_constraint",
          message: "sidecar refused",
          details: { reason: "busy" },
        },
      })
    },
    JSON.stringify({
      error: {
        code: -32000,
        message: "sidecar refused",
        data: { reason: "busy" },
      },
    })
  )
})

test("dispatchSyncTool returns typed synapse_error from result metadata", async () => {
  await withRegisteredTunnel(
    async (fetchImpl) => {
      const result = await dispatchSyncTool(baseDispatchOptions(fetchImpl))

      assert.deepEqual(result, {
        ok: false,
        error: {
          code: "permission_denied",
          message: "grant missing",
          details: { capability: "filesystem" },
        },
      })
    },
    JSON.stringify({
      result: {
        content: [],
        _meta: {
          synapse_error: {
            code: "permission_denied",
            message: "grant missing",
            details: { capability: "filesystem" },
          },
        },
      },
    })
  )
})

test("dispatchSyncTool fails closed for malformed JSON-RPC response bodies", async () => {
  for (const [responseText, message] of [
    ["{not-json", "dispatch response must be valid JSON"],
    ["[1,2,3]", "dispatch response must be a JSON object"],
    ["null", "dispatch response must be a JSON object"],
    [
      JSON.stringify({ result: null }),
      "dispatch response result must be a CallToolResult object",
    ],
    [
      JSON.stringify({ error: { message: 42 } }),
      "dispatch response error must be a JSON-RPC error object",
    ],
  ] as const) {
    await withRegisteredTunnel(async (fetchImpl) => {
      const result = await dispatchSyncTool(baseDispatchOptions(fetchImpl))

      assert.deepEqual(result, {
        ok: false,
        error: {
          code: "runtime_constraint",
          message,
        },
      })
    }, responseText)
  }
})

test("dispatchSyncTool fails closed for malformed synapse_error metadata", async () => {
  await withRegisteredTunnel(
    async (fetchImpl) => {
      const result = await dispatchSyncTool(baseDispatchOptions(fetchImpl))

      assert.deepEqual(result, {
        ok: false,
        error: {
          code: "runtime_constraint",
          message: "dispatch response synapse_error must match SynapseError",
        },
      })
    },
    JSON.stringify({
      result: {
        content: [],
        _meta: {
          synapse_error: {
            code: "unknown_code",
            message: "bad",
          },
        },
      },
    })
  )
})
