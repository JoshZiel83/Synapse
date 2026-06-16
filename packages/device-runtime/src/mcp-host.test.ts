// Data-plane smoke test: the in-memory MCP host actually listens on a
// loopback port and routes tools/list + tools/call to a registered provider.

import test from "node:test"
import assert from "node:assert/strict"

import { createInMemoryMcpHost } from "./mcp-host.js"
import { createCommandlineBuiltin } from "./builtins/commandline.js"

interface JsonRpcResponse {
  id: string | number | null
  result?: {
    tools?: { name: string }[]
    content?: { type: string; text: string }[]
    isError?: boolean
    _meta?: Record<string, unknown>
  }
  error?: { code: number; message: string }
}

async function rpc(
  base: string,
  body: { id: string; method: string; params?: unknown }
): Promise<JsonRpcResponse> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", ...body }),
  })
  return (await res.json()) as JsonRpcResponse
}

async function rpcRaw(
  base: string,
  body: string
): Promise<{ status: number; payload: JsonRpcResponse }> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  })
  return {
    status: res.status,
    payload: (await res.json()) as JsonRpcResponse,
  }
}

test("mcp host accepts tools/list + tools/call over HTTP", async () => {
  const host = createInMemoryMcpHost()
  await host.start()
  try {
    await host.registerCatalog(createCommandlineBuiltin())
    const base = `http://127.0.0.1:${host.localPort}`
    assert.ok(host.localPort > 0, "host should pick a real port")

    const list = await rpc(base, { id: "1", method: "tools/list" })
    assert.equal(
      list.result?.tools?.find((t) => t.name === "bash") !== undefined,
      true
    )

    const call = await rpc(base, {
      id: "2",
      method: "tools/call",
      params: { name: "bash", arguments: { command: 'printf "hi"' } },
    })
    assert.equal(call.error, undefined)
    assert.equal(call.result?.isError, false)
    assert.match(call.result?.content?.[0]?.text ?? "", /hi/)
  } finally {
    await host.stop()
  }
})

test("mcp host rejects malformed JSON with parse error", async () => {
  const host = createInMemoryMcpHost()
  await host.start()
  try {
    const base = `http://127.0.0.1:${host.localPort}`
    const response = await rpcRaw(base, "{not-json")
    assert.equal(response.status, 400)
    assert.equal(response.payload.id, null)
    assert.equal(response.payload.error?.code, -32700)
  } finally {
    await host.stop()
  }
})

test("mcp host rejects non-object JSON-RPC bodies with invalid request", async () => {
  const host = createInMemoryMcpHost()
  await host.start()
  try {
    const base = `http://127.0.0.1:${host.localPort}`
    for (const raw of ["null", "[]", '"method"']) {
      const response = await rpcRaw(base, raw)
      assert.equal(response.status, 200)
      assert.equal(response.payload.id, null)
      assert.equal(response.payload.error?.code, -32600)
      assert.equal(response.payload.error?.message, "invalid request")
    }
  } finally {
    await host.stop()
  }
})

test("mcp host returns structured error for unknown tool", async () => {
  const host = createInMemoryMcpHost()
  await host.start()
  try {
    const base = `http://127.0.0.1:${host.localPort}`
    const res = await rpc(base, {
      id: "3",
      method: "tools/call",
      params: { name: "definitely_not_a_tool", arguments: {} },
    })
    assert.equal(res.result?.isError, true)
    const synapseError = res.result?._meta?.["synapse_error"] as
      | { code: string; message: string }
      | undefined
    assert.equal(synapseError?.code, "invalid_request")
  } finally {
    await host.stop()
  }
})
