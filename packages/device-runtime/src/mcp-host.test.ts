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

// ─────────────────── §3.4 inbound-bearer gate (direct data plane) ───────────────

async function rpcAuth(
  base: string,
  authorization: string | undefined,
  body: { id: string; method: string; params?: unknown }
): Promise<{ status: number; payload: JsonRpcResponse }> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (authorization !== undefined) headers.authorization = authorization
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", ...body }),
  })
  return { status: res.status, payload: (await res.json()) as JsonRpcResponse }
}

test("requiredInboundAuth gates initialize + tools/list + tools/call alike", async () => {
  const BEARER = "deadbeef".repeat(8)
  const host = createInMemoryMcpHost({ requiredInboundAuth: BEARER })
  await host.start()
  try {
    await host.registerCatalog(createCommandlineBuiltin())
    const base = `http://127.0.0.1:${host.localPort}`
    for (const method of ["initialize", "tools/list", "tools/call"]) {
      // no Authorization → 401 (closes the unauthenticated-enumeration gap).
      const none = await rpcAuth(base, undefined, { id: "1", method })
      assert.equal(none.status, 401, `${method} without bearer must be 401`)
      // wrong bearer → 401.
      const wrong = await rpcAuth(base, "Bearer not-the-token", {
        id: "2",
        method,
      })
      assert.equal(wrong.status, 401, `${method} with wrong bearer must be 401`)
      // malformed header (no "Bearer " prefix) → 401.
      const bare = await rpcAuth(base, BEARER, { id: "3", method })
      assert.equal(
        bare.status,
        401,
        `${method} with a non-Bearer header must be 401`
      )
    }
    // correct bearer → the method runs (200).
    const ok = await rpcAuth(base, `Bearer ${BEARER}`, {
      id: "4",
      method: "tools/list",
    })
    assert.equal(ok.status, 200)
    assert.ok(ok.payload.result?.tools)
  } finally {
    await host.stop()
  }
})

test("no requiredInboundAuth → loopback path unchanged (bearer not required, zero cost)", async () => {
  const host = createInMemoryMcpHost()
  await host.start()
  try {
    const base = `http://127.0.0.1:${host.localPort}`
    const res = await rpcAuth(base, undefined, {
      id: "1",
      method: "tools/list",
    })
    assert.equal(res.status, 200)
  } finally {
    await host.stop()
  }
})

test("fail-closed bind: a non-loopback bind without requiredInboundAuth throws at startup", async () => {
  const host = createInMemoryMcpHost({ host: "0.0.0.0" })
  await assert.rejects(host.start(), /non-loopback.*requiredInboundAuth/)
  // and with a bearer configured, a non-loopback bind is permitted.
  const ok = createInMemoryMcpHost({
    host: "0.0.0.0",
    requiredInboundAuth: "x".repeat(16),
  })
  await ok.start()
  await ok.stop()
})
