import assert from "node:assert/strict"
import test from "node:test"

import {
  OperationEnvelopeSchema,
  type OperationEnvelope,
} from "@synapse/device-protocol"
import { dispatchSyncTool } from "./dispatch.js"
import {
  createInMemoryDeviceTunnelRegistry,
  getDeviceTunnelRegistry,
  setDeviceTunnelRegistry,
} from "./tunnel-registry.js"

const ENVELOPE: OperationEnvelope = OperationEnvelopeSchema.parse({
  operation_id: "00000000-0000-4000-8000-000000000001",
  attempt_id: "00000000-0000-4000-8000-000000000002",
  device_runtime_session_id: "00000000-0000-4000-8000-000000000003",
  device_capability_id: "00000000-0000-4000-8000-000000000004",
  device_exposure_id: "00000000-0000-4000-8000-000000000005",
  device_tool_id: "00000000-0000-4000-8000-000000000006",
  device_tool_revision_id: "00000000-0000-4000-8000-000000000007",
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
    })
    return new Response(responseText, { status })
  }) as typeof fetch
  return { fetchImpl, calls }
}

async function withRegisteredTunnel<T>(
  run: (fetchImpl: typeof fetch, calls: FetchCall[]) => Promise<T>,
  responseText: string
): Promise<T> {
  const previousRegistry = getDeviceTunnelRegistry()
  const registry = createInMemoryDeviceTunnelRegistry()
  registry.register({
    deviceServiceId: "svc-1",
    internalUrl: "http://device-runtime.local/session/",
  })
  setDeviceTunnelRegistry(registry)
  const { fetchImpl, calls } = makeFetchResponse(responseText)
  try {
    return await run(fetchImpl, calls)
  } finally {
    setDeviceTunnelRegistry(previousRegistry)
  }
}

function baseDispatchOptions(fetchImpl: typeof fetch) {
  return {
    deviceServiceId: "svc-1",
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
      assert.deepEqual(calls[0]?.body, {
        jsonrpc: "2.0",
        id: ENVELOPE.attempt_id,
        method: "tools/call",
        params: {
          name: "tool.echo",
          arguments: { input: "hello" },
          _meta: { synapse_operation: ENVELOPE },
        },
      })
    },
    JSON.stringify({
      result: { content: [{ type: "text", text: "ok" }] },
    })
  )
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
