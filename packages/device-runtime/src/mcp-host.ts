// In-process catalog manager + MCP host. v3.0 implementation is a minimal
// JSON-RPC over HTTP server bound to 127.0.0.1:0; the frp tunnel adapter
// fronts it so the API side can reach `tools/list` and `tools/call` through
// a Streamable HTTP transport without taking a hard dep on the upstream
// `@modelcontextprotocol/sdk` McpServer wrapper.
//
// MCP error-code preservation decision (§14 open item): we choose option (b)
// — embed code in `CallToolResult._meta.synapse_error`. This lets the host
// surface structured Synapse errors without leaving the high-level CallTool
// contract.

import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import type {
  DeviceCatalogExposure,
  DeviceCatalogTool,
  OperationEnvelope,
  SynapseError,
} from "@synapse/device-protocol"
import type {
  CatalogProvider,
  CatalogToolInvocationResult,
  EnvelopeVerifier,
  McpHost,
} from "./types.js"
import { hashArguments } from "./envelope.js"

export interface InMemoryMcpHostHandle extends McpHost {
  getCatalogSnapshot(): Promise<DeviceCatalogExposure[]>
}

export interface InMemoryMcpHostOptions {
  /** Optional hostname / port override. Defaults to 127.0.0.1 + random port. */
  host?: string
  port?: number
  /**
   * Required when running outside loopback-only smoke tests: every tools/call
   * envelope must verify against this verifier + the serverPublicKeys map
   * before the provider is invoked. If absent, the host falls back to a
   * "no verification" mode (signed-but-not-checked) which is fine for
   * tests that exercise the host in isolation but unsafe for production.
   */
  envelopeVerifier?: EnvelopeVerifier
  serverPublicKeys?: ReadonlyMap<string, string>
}

interface ToolEntry {
  exposureKey: string
  tool: DeviceCatalogTool
  provider: CatalogProvider
}

export function createInMemoryMcpHost(
  opts: InMemoryMcpHostOptions = {}
): InMemoryMcpHostHandle {
  const providers = new Map<string, CatalogProvider>()
  let server: Server | null = null
  let listenPort = 0

  async function buildToolIndex(): Promise<Map<string, ToolEntry>> {
    const index = new Map<string, ToolEntry>()
    for (const provider of providers.values()) {
      const exposures = await provider.describeExposures()
      for (const exposure of exposures) {
        for (const tool of exposure.tools) {
          index.set(tool.name, {
            exposureKey: exposure.stable_key,
            tool,
            provider,
          })
        }
      }
    }
    return index
  }

  async function listAllTools(): Promise<DeviceCatalogTool[]> {
    const out: DeviceCatalogTool[] = []
    for (const entry of (await buildToolIndex()).values()) {
      out.push(entry.tool)
    }
    return out
  }

  async function dispatchCallTool(params: {
    name: unknown
    arguments?: unknown
    _meta?: unknown
  }): Promise<CatalogToolInvocationResult> {
    if (typeof params.name !== "string") {
      const synapseError: SynapseError = {
        code: "invalid_request",
        message: "tools/call params.name must be a string",
      }
      return {
        content: [{ type: "text", text: synapseError.message }],
        isError: true,
        _meta: { synapse_error: synapseError },
      }
    }
    const args =
      params.arguments && typeof params.arguments === "object"
        ? (params.arguments as Record<string, unknown>)
        : {}
    const envelope = extractEnvelope(params._meta)
    // Envelope verification gates every tool call. If the runtime was
    // configured with a verifier + trusted server keys, every call MUST
    // present a verified envelope; calls without one (or with an envelope
    // that fails verification) get a `permission_denied` synapse_error.
    if (opts.envelopeVerifier && opts.serverPublicKeys) {
      if (!envelope) {
        const synapseError: SynapseError = {
          code: "permission_denied",
          message:
            "tools/call requires _meta.synapse_operation envelope when the runtime is configured with trusted server keys",
        }
        return {
          content: [{ type: "text", text: synapseError.message }],
          isError: true,
          _meta: { synapse_error: synapseError },
        }
      }
      const verifyResult = await opts.envelopeVerifier.verify(
        envelope,
        hashArguments(args),
        opts.serverPublicKeys
      )
      if (!verifyResult.ok) {
        const synapseError: SynapseError = {
          code: verifyResult.code,
          message: verifyResult.message,
        }
        return {
          content: [{ type: "text", text: synapseError.message }],
          isError: true,
          _meta: { synapse_error: synapseError },
        }
      }
    }
    const index = await buildToolIndex()
    const entry = index.get(params.name)
    if (!entry) {
      const synapseError: SynapseError = {
        code: "invalid_request",
        message: `unknown tool ${params.name}`,
      }
      return {
        content: [{ type: "text", text: synapseError.message }],
        isError: true,
        _meta: { synapse_error: synapseError },
      }
    }
    if (!entry.provider.invokeTool) {
      const synapseError: SynapseError = {
        code: "runtime_constraint",
        message: `tool ${params.name} has no executable handler in v3.0 skeleton`,
      }
      return {
        content: [{ type: "text", text: synapseError.message }],
        isError: true,
        _meta: { synapse_error: synapseError },
      }
    }
    try {
      return await entry.provider.invokeTool({
        toolName: params.name,
        args,
        envelope,
      })
    } catch (err) {
      const synapseError: SynapseError = {
        code: "runtime_constraint",
        message: `tool ${params.name} threw: ${(err as Error).message}`,
      }
      return {
        content: [{ type: "text", text: synapseError.message }],
        isError: true,
        _meta: { synapse_error: synapseError },
      }
    }
  }

  function extractEnvelope(meta: unknown): OperationEnvelope | undefined {
    if (!meta || typeof meta !== "object") return undefined
    const raw = (meta as Record<string, unknown>)["synapse_operation"]
    if (!raw || typeof raw !== "object") return undefined
    return raw as OperationEnvelope
  }

  async function handleJsonRpc(body: {
    id?: string | number | null
    method?: unknown
    params?: unknown
  }): Promise<{ id: string | number | null; result?: unknown; error?: { code: number; message: string } }> {
    const id = (body.id ?? null) as string | number | null
    if (typeof body.method !== "string") {
      return { id, error: { code: -32600, message: "method required" } }
    }
    switch (body.method) {
      case "initialize": {
        return {
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: {
              name: "@synapse/device-runtime",
              version: "0.1.0",
            },
          },
        }
      }
      case "tools/list": {
        return { id, result: { tools: await listAllTools() } }
      }
      case "tools/call": {
        const params =
          body.params && typeof body.params === "object"
            ? (body.params as { name: unknown; arguments?: unknown; _meta?: unknown })
            : { name: undefined }
        const result = await dispatchCallTool(params)
        return { id, result }
      }
      default: {
        return {
          id,
          error: { code: -32601, message: `method not found: ${body.method}` },
        }
      }
    }
  }

  async function startServer(): Promise<void> {
    if (server) return
    const host = opts.host ?? "127.0.0.1"
    const port = opts.port ?? 0
    server = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/mcp") {
        res.statusCode = 404
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ error: { code: -32601, message: "not found" } }))
        return
      }
      const chunks: Buffer[] = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => {
        ;(async () => {
          let body: unknown
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
          } catch {
            res.statusCode = 400
            res.setHeader("content-type", "application/json")
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: null,
                error: { code: -32700, message: "parse error" },
              })
            )
            return
          }
          const envelope = await handleJsonRpc(
            body as { id?: string | number | null; method?: unknown; params?: unknown }
          )
          res.statusCode = 200
          res.setHeader("content-type", "application/json")
          res.end(JSON.stringify({ jsonrpc: "2.0", ...envelope }))
        })().catch((err) => {
          res.statusCode = 500
          res.setHeader("content-type", "application/json")
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32603, message: (err as Error).message },
            })
          )
        })
      })
    })
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject)
      server!.listen(port, host, () => {
        const addr = server!.address() as AddressInfo
        listenPort = addr.port
        resolve()
      })
    })
  }

  async function stopServer(): Promise<void> {
    if (!server) return
    await new Promise<void>((resolve) =>
      server!.close(() => resolve())
    )
    server = null
    listenPort = 0
  }

  return {
    get localPort() {
      return listenPort
    },
    async start() {
      await startServer()
    },
    async stop() {
      await stopServer()
    },
    async registerCatalog(provider: CatalogProvider) {
      providers.set(provider.providerKey, provider)
    },
    async unregisterCatalog(providerKey: string) {
      providers.delete(providerKey)
    },
    async getCatalogSnapshot() {
      const all: DeviceCatalogExposure[] = []
      for (const provider of providers.values()) {
        const exposures = await provider.describeExposures()
        all.push(...exposures)
      }
      return all
    },
  }
}

/**
 * Helper for builtin tool handlers to surface a structured error via the
 * `_meta.synapse_error` field of the MCP CallToolResult so the API side can
 * recover the v3 device-side error code (§4.5).
 */
export function toolErrorResult(err: SynapseError): CatalogToolInvocationResult {
  return {
    content: [{ type: "text" as const, text: err.message }],
    isError: true,
    _meta: { synapse_error: err },
  }
}
